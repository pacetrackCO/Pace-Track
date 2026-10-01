---
name: Media artifact isolation
description: Adding a code-rendered media artifact alongside PaceTrack's legacy npm server
---

Keep media artifacts independently installable rather than migrating the PaceTrack server into a generated monorepo just to create a story.

**Why:** The artifact scaffold assumes a pnpm dependency catalog and a shared TypeScript base configuration that this legacy npm project does not have. Its automatic installation can therefore finish without installing the artifact's dependencies.

**How to apply:** When adding media artifacts, check those scaffold assumptions before verification, use artifact-local package and TypeScript configuration, and preserve the main server's dependency and publishing configuration.