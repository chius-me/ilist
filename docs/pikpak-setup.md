# PikPak Setup

PikPak mounts are configured entirely in `/admin/storages`. No PikPak deployment secret is required.

## Connect a mount

1. Sign in to ilist and open `/admin/storages`.
2. Choose **PikPak**, then enter a unique name and mount path.
3. Enter either a username/email/phone plus password, or a refresh token in the advanced field.
4. Optionally enter a root folder ID. Blank means the PikPak root.
5. Save and run **Test connection**.

The password is used only to obtain provider session tokens and is discarded. Refresh/access tokens, device state, and CAPTCHA session state are encrypted in D1. If PikPak requires interactive CAPTCHA or account verification, ilist does not bypass it; complete verification through PikPak and retry, or configure a refresh token.

## Supported behavior

ilist supports listing, metadata, original-file downloads with Range forwarding, folder creation, rename, move, and recoverable trash deletion. Downloads are proxied through the Worker because PikPak links may be session/IP sensitive. Provider-side copy is not advertised. Upload is currently rejected with a stable unsupported response rather than buffering a complete file in Worker memory; a future release can add it once a safely testable upload-ticket flow is available.

PikPak APIs are not offered as a stable public developer platform and may change. The implementation is isolated under `src/worker/drivers/pikpak/`, and CI uses mocked provider responses rather than real credentials.
