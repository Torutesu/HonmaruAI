# Fonts

The latin subsets of the three faces the page uses, as served by Google Fonts
and kept here so the page makes no third-party request before it paints.
Japanese falls back to the system's own face (Hiragino, Noto Sans JP).

| File | Face | Weights | License |
|------|------|---------|---------|
| `plus-jakarta-sans-latin.woff2` | Plus Jakarta Sans (variable) | 600–800 | SIL Open Font License 1.1 |
| `inter-latin.woff2` | Inter (variable) | 400–600 | SIL Open Font License 1.1 |
| `sometype-mono-latin.woff2` | Sometype Mono | 500 | SIL Open Font License 1.1 |

Plus Jakarta Sans is preloaded, since it draws the headline. To change weights,
fetch the css2 URL with a modern browser's User-Agent and take the `latin`
block's woff2.
