# App icon correction

The production 1.0 / build 42 and prepared 1.0.1 / build 44 contained the old
card-stack AppIcon. The in-app AppMark had already been updated, but the separate
AppIcon catalog was not migrated during UI integration.

This correction reuses the existing approved 1024 × 1024 RGB PNG, byte-for-byte,
from the original product workspace. No AI redraw or stylistic modification.
The source is Figma `ii8w8x7gvN3wp70vlszBSa`, Logo `590:143` in frame `590:142`,
reverified against live design context on 2026-09-22. The square #202020 background
and original silver gradient geometry match the in-app logo; iOS applies its mask.

- PNG SHA-256: `24abcc3c1e0b58ecef60bc7fbbfb3ea7662b057e7beb677ff59e344bd01269ee`
- Catalog: `TikTokForWork/Assets.xcassets/AppIcon.appiconset`
- The old sibling SVG source is replaced with the matching approved source.
- The release regression gate checks the approved bytes, dimensions, RGB format
  and catalog filename so this mismatch cannot silently return.

Changing the source is not proof of public release. Verify the signed archive,
uploaded build icon and App Store version relationship separately. The published
icon only changes after the corrected update is reviewed and released.
