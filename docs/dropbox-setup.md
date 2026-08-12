# Dropbox Setup

ilist connects each Dropbox mount through a scoped OAuth 2.0 app. Access and refresh tokens are encrypted in D1 with `CREDENTIAL_MASTER_KEY`; they are never returned to the browser.

## Create the Dropbox app

1. Open the Dropbox App Console and create a scoped API app.
2. Choose either **App folder** or **Full Dropbox** access. This becomes the maximum visible root for authorizations issued by the app.
3. Enable these permissions:
   - `files.metadata.read`
   - `files.metadata.write`
   - `files.content.read`
   - `files.content.write`
4. Add the exact production redirect URI:

   ```text
   https://ilist.chius.cc/api/admin/oauth/dropbox/callback
   ```

Keep the workers.dev callback registered until the custom-domain flow has been verified if that hostname remains in use during deployment.

## Configure Worker secrets

Dropbox calls its OAuth client credentials the app key and app secret. Store them as:

```bash
npx wrangler secret put DROPBOX_CLIENT_ID
npx wrangler secret put DROPBOX_CLIENT_SECRET
npx wrangler secret put PUBLIC_ORIGIN
```

`PUBLIC_ORIGIN` must be the exact HTTPS origin without a trailing slash. Keep `CREDENTIAL_MASTER_KEY` stable because it encrypts Dropbox refresh tokens, OAuth state, and resumable-upload state.

## Connect a mount

Sign in to ilist, open `/admin/storages`, create a Dropbox mount, and complete the authorization redirect. Leave **Root folder ID** blank to mount the app's authorized Dropbox root, or enter a Dropbox folder ID such as `id:...` to restrict the mount to that subtree.

Dropbox Business team impersonation and explicit team-space namespace selection are not included. Upload sessions remain server-side and expire before Dropbox's seven-day provider limit; abort closes the local session and performs a best-effort remote close.
