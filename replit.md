# PaceTrack

The imported website uses vanilla HTML, CSS and JavaScript, with Netlify configuration and external device-sync services. Keep the original stack and directory structure.

## Design workspace

The user requested a visual refresh across the entire interface, retaining the original orange/amber identity or harmonious colors. The design preview uses orange, amber and night blue.

The original website files have not been modified. Isolated copies live under `artifacts/mockup-sandbox/public/pacetrack-current/` (baseline) and `pacetrack-refresh/` (redesign). The sandbox's React wrappers are preview infrastructure, not a migration of the website.

Use the managed workflow `artifacts/mockup-sandbox: Component Preview Server` to run the design preview. It runs `npm run dev` in `artifacts/mockup-sandbox`; the service configuration supplies its port and `/__mockup/` base path.

Preview routes:
- `/__mockup/preview/pacetrack/Current`
- `/__mockup/preview/pacetrack/Refresh`

The refresh selector opens all eight existing pages. For inspection, the refresh URL supports `?page=timer|loop|sector|events|pc|mobilepc|construction` and `&viewport=mobile` (390px).

Contact submissions and external Firebase signaling/results synchronization are explicitly disabled in the preview copies. Local camera-based timing still requires permission and a compatible secure browser. Do not treat device synchronization as tested or operational in this preview.

Apply a user-approved design to the original vanilla site separately; retain original event hooks and services rather than copying preview-only service disabling.