# OneDrive Personal Setup

ilist uses the Microsoft identity platform authorization-code flow with PKCE and the `consumers` tenant. This release intentionally accepts personal Microsoft accounts only. Work and school accounts are deferred.

## 1. Register the Microsoft application

1. Open Microsoft Entra admin center, then go to **Identity > Applications > App registrations > New registration**.
2. Enter a recognizable application name.
3. Select **Personal Microsoft accounts only** as the supported account type.
4. Register the application and record its **Application (client) ID**.
5. Under **Authentication**, add the **Web** platform with this exact redirect URI:

   ```text
   https://YOUR_ILIST_ORIGIN/api/admin/oauth/onedrive/callback
   ```

6. Under **Certificates & secrets**, create a client secret and record its value immediately.
7. Under **API permissions**, add delegated Microsoft Graph permissions `User.Read` and `Files.ReadWrite`. ilist also requests the OAuth scope `offline_access` so it can refresh access tokens.

The redirect URI must use the same origin as `PUBLIC_ORIGIN`, including scheme and hostname. `PUBLIC_ORIGIN` must not contain a path or trailing slash.

## 2. Configure Worker secrets

Generate secrets locally and keep the output outside Git:

```bash
npm run hash-password -- "your-admin-password"
openssl rand -base64 32
openssl rand -hex 32
```

Configure these values under **Workers & Pages > ilist > Settings > Variables and Secrets**, marking every value as a secret:

| Name | Value |
| --- | --- |
| `ADMIN_PASSWORD_HASH` | Output from `npm run hash-password` |
| `CREDENTIAL_MASTER_KEY` | 32 random bytes encoded as base64 |
| `SESSION_SECRET` | At least 32 random characters |
| `MICROSOFT_CLIENT_ID` | Application (client) ID |
| `MICROSOFT_CLIENT_SECRET` | Microsoft client secret value |
| `PUBLIC_ORIGIN` | Exact deployed HTTPS origin, without trailing slash |

Wrangler can also set each value with `npx wrangler secret put NAME`. Do not put production values in `.dev.vars`, `wrangler.jsonc`, shell history, or screenshots.

`CREDENTIAL_MASTER_KEY` encrypts S3 credentials, OneDrive refresh tokens, and pending OAuth verifiers in D1. Back it up in a password manager and do not rotate it without a credential re-encryption migration.

## 3. Apply migrations and deploy

Export D1 before changing production:

```bash
npx wrangler d1 export ilist-db --remote --output /tmp/ilist-db-before-multi-mount.sql
npx wrangler d1 migrations apply ilist-db --remote
npm run deploy
```

Migrations `0008` through `0014` add mounts, encrypted credentials, the native R2 compatibility mount, one-time OAuth state, resumable upload sessions, and controlled shares. They do not delete files or legacy rows.

## 4. Connect drives

1. Sign in to ilist and open `/admin/storages`.
2. Select **Add storage**, choose **OneDrive Personal**, and enter a unique display name and mount path.
3. Select **Create and connect**, sign in to Microsoft, and grant the requested access.
4. Return to storage settings and run the connection test.
5. Repeat with a different name and path to mount another personal account.

Disconnecting deletes only the encrypted OAuth credentials from ilist. Deleting a mount removes its configuration and credentials; neither action deletes OneDrive files.

## 5. Verification and rollback

Verify the public root, a nested OneDrive folder, small and resumable upload/download/delete cycles, a private mount as a guest, and existing native R2 links. Large files use a server-side OneDrive upload session; the provider upload URL and session proof are never returned to the browser.

If the deployment fails, deploy the previous Worker version and keep migrations `0008` through `0011` in place; older code ignores the additive tables. Restore the D1 export only when data itself is damaged, not merely to roll back Worker code.

Reference documentation:

- [Microsoft app registration](https://learn.microsoft.com/en-us/graph/auth-register-app-v2)
- [Microsoft redirect URI configuration](https://learn.microsoft.com/en-us/entra/identity-platform/how-to-add-redirect-uri)
- [Cloudflare Worker secrets](https://developers.cloudflare.com/workers/configuration/secrets/)
- [Cloudflare R2 S3 compatibility](https://developers.cloudflare.com/r2/api/s3/api/)
