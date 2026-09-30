---
name: Vite public asset discovery
description: Silent HTML fallback for newly copied public assets in the design preview server.
---

After adding entire directories under the sandbox's public folder while Vite is already running, restart the managed preview workflow once before final visual verification.

**Why:** Newly copied images and stylesheets returned HTTP 200 with the sandbox HTML fallback even though the files existed. Existing CSS was served correctly, making the problem resemble broken paths. A restart made the new assets serve with their proper content types.

**How to apply:** When a copied image or stylesheet appears broken, check its response content type, not just status or filesystem existence. Complete the asset-copy batch before restarting; avoid editing correct URLs to compensate for stale discovery.