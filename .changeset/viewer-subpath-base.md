---
"@ifc-lite/viewer": patch
---

The viewer now works when built with `vite build --base=/Some/Path/` and served under that subpath: the bundled samples, the logo, the `/mcp` pages and Cesium's assets follow Vite's base instead of assuming the domain root. At the root (the default) nothing changes.
