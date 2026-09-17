# Shared media loading

Shared document text and Markdown remain server-rendered. Small client media components observe images and videos within 600px of the viewport, combine requests over 16ms, and request at most 50 distinct media URLs per batch. Only one batch runs at a time per page. External media stays on its original URL. Pending private media reserves a minimum 3rem height until its URL resolves; no-JavaScript readers receive the stable media URL through a noscript fallback.

The Next.js batch endpoint forwards requests to `get-shared-doc`. Each batch rechecks the current share token and `share_enabled`, parses the document's allowed references once, validates owner/document/path for each item, and calls Storage `createSignedUrls` once per populated bucket. Invalid or unreferenced paths return no URL. Authorized Storage failures can retry using the original single-media route. Credentials remain in the Edge Function runtime.

Signatures last five minutes. The mounted page only reuses signatures for 285 seconds from the start of its request; responses that arrive after that window fall back to the stable route. Lazy images or videos whose signatures expire before download retry the stable route once on an error. Batch requests and responses retain `no-store`; signatures are never written to IndexedDB, local storage, or the service worker cache. As with the existing signed URLs, previously issued signatures remain usable until they expire after a share is revoked.

## Deployment

Deploy the updated `get-shared-doc` Edge Function, then the Next.js application. No migration, environment variable, bucket policy, or maintenance-function change is required. Both versions of the single-media endpoint remain supported. If Next.js goes first, an older Edge Function returns its existing document response; the new Next.js endpoint recognizes that shape, returns 503, and the browser falls back to the stable single-media route for the remainder of the page visit. Old Next.js deployments also work with the updated Edge Function.

## Verification

Automated checks cover a batch's one document lookup/per-bucket signatures, duplicates and mixed invalid references, share revocation, partial Storage failures, bounded batch concurrency, URL expiry, old-edge fallback, offscreen observations, changed media props, and no-JavaScript SSR markup. A live-account check should load a shared document with several images plus a video/poster, scroll to later media after five minutes, revoke sharing before requesting new media, and confirm the same behavior with JavaScript disabled. Automated tests and synthetic fixtures do not establish deployed latency.
