# Google Drive Setup

ilist uses the Google OAuth 2.0 authorization-code flow with PKCE and Google Drive API v3. Each Google mount has its own encrypted refresh token, display name, mount path, and optional root folder ID.

## 1. Configure Google Cloud

1. Create or select a project in Google Cloud Console.
2. Enable **Google Drive API** for the project.
3. Configure the OAuth consent screen. During development, keep the application in **Testing** and add every account that will authorize a mount as a test user.
4. Create an OAuth client with application type **Web application**.
5. Add this exact authorized redirect URI:

   ```text
   https://YOUR_ILIST_ORIGIN/api/admin/oauth/google/callback
   ```

6. Record the OAuth client ID and client secret.

The redirect origin must match `PUBLIC_ORIGIN` exactly, including scheme and hostname. `PUBLIC_ORIGIN` must not contain a path or trailing slash.

ilist requests this scope:

```text
https://www.googleapis.com/auth/drive
```

The full Drive scope is required for an OpenList-style browser that can list and manage existing files. A public application may need Google verification before accounts outside its configured test users can authorize it.

## 2. Configure Worker secrets

Store production values as encrypted Worker secrets:

```bash
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put PUBLIC_ORIGIN
```

`CREDENTIAL_MASTER_KEY` must also remain configured and stable because it encrypts refresh tokens and one-time OAuth state in D1. Do not put production client secrets, tokens, or encryption keys in `.dev.vars`, `wrangler.jsonc`, shell history, screenshots, or Git.

## 3. Connect a mount

1. Sign in to ilist and open `/admin/storages`.
2. Select **Add storage**, then choose **Google Drive**.
3. Enter a unique display name and mount path.
4. Optionally enter a root folder ID to expose only that folder. The ID is the segment after `/folders/` in a Google Drive folder URL.
5. Select **Create and connect**, sign in to Google, and approve access.
6. Repeat with another name and path to authorize another Google account or root.

Disconnecting removes only the encrypted Google credentials from ilist. Deleting a mount removes its ilist configuration and credentials. Neither operation deletes Google Drive files.

## 4. Supported behavior

- Browse My Drive folders and ordinary files.
- Stream ordinary downloads and forward valid single byte ranges.
- Export Google Docs as PDF or DOCX, Sheets as PDF or XLSX, and Slides as PDF or PPTX.
- Preview Workspace-native files through their PDF export.
- Upload small files and use private resumable upload sessions for larger files.
- Create folders, rename, move, and move items to trash.
- Use multiple mounts without sharing credentials or root scope between them.

Provider access tokens, refresh tokens, and resumable session URLs are not returned to the browser. Upload chunks pass through ilist's authenticated endpoints.

## 5. Current limitations

- My Drive only; Shared Drives and **Shared with me** are not implemented.
- Google Drive shortcuts are not traversed.
- Google Workspace-native files require an explicit export format for download.
- Upload queue recovery is limited to the current page session.
- Provider listings are fetched live and are not cached in a distributed directory index.

Before deployment, back up D1 and apply all migrations. After deployment, verify authorization, nested listing, an ordinary Range download, each required Workspace export family, small and resumable upload, create, rename, move, trash, disconnect, and reconnect.
