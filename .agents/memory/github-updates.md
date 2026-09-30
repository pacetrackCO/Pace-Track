---
name: GitHub updates
description: Safe repository updates when the imported native Git credentials are unusable.
---

When native Git authentication fails, use the bound GitHub connection's authenticated proxy rather than requesting or handling a token.

**Why:** The imported remote rejected native Git writes despite the existing GitHub connection having repository write access. The Git Data API allowed publishing the exact locally verified commit without exposing credentials.

**How to apply:** Build changes against the current remote parent, verify the API-created tree and commit hashes match the local objects, and update the branch with `force: false`. Refuse the update if the branch has advanced. For larger multi-file updates, read the files inside the impure operation that calls the proxy rather than passing bulk file contents through shell stdout.