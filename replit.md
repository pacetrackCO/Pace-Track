# PaceTrack

The imported website uses vanilla HTML, CSS and JavaScript, with Netlify configuration and external device-sync services. Keep the original stack and directory structure.

## Design workspace

The user requested a visual refresh across the entire interface, retaining the original orange/amber identity or harmonious colors. The design preview uses orange, amber and night blue.

The approved design is integrated into all eight original pages through the root `pacetrack-ui.css`. The site retains vanilla HTML/CSS/JavaScript and its original Netlify and Firebase service code. Isolated copies remain under `artifacts/mockup-sandbox/public/pacetrack-current/` (baseline) and `pacetrack-refresh/` (design reference). The sandbox's React wrappers are preview infrastructure, not a migration of the website.

## Running the website

The `PaceTrack` workflow runs `python3 -m http.server 5000 --bind 0.0.0.0` from the project root for local visual inspection. Open `/` or the existing explicit HTML page paths. This is a static development server: Netlify redirects, server functions and contact submission still require the original hosting services; they are not emulated locally.

Run `node tests/verify-interface.mjs` to check all eight pages, required controls, local assets, service dependencies and JavaScript syntax.

Use the managed workflow `artifacts/mockup-sandbox: Component Preview Server` to run the design preview. It runs `npm run dev` in `artifacts/mockup-sandbox`; the service configuration supplies its port and `/__mockup/` base path.

Preview routes:
- `/__mockup/preview/pacetrack/Current`
- `/__mockup/preview/pacetrack/Refresh`

The refresh selector opens all eight existing pages. For inspection, the refresh URL supports `?page=timer|loop|sector|events|pc|mobilepc|construction` and `&viewport=mobile` (390px).

Contact submissions and external Firebase signaling/results synchronization are explicitly disabled in the preview copies. Local camera-based timing still requires permission and a compatible secure browser. Do not treat device synchronization as tested or operational in this preview.

When updating the website from any later design reference, retain original event hooks and services rather than copying preview-only service disabling. Timer text colors are operational status indicators controlled by the timer scripts; do not override them with `!important` in shared styles.