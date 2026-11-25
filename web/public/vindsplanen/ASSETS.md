# Vindsplanen texture assets

All sets are CC0 (public domain) from Poly Haven, downloaded 2026-11-25 as the
1k and 2k JPG variants and repacked by us into `tex/<set>/{1k,2k}/`:

- `color.jpg` — sRGB diffuse (JPEG q82)
- `normal.jpg` — OpenGL-convention normal map (q90)
- `orm.jpg` — R = ambient occlusion, G = roughness, B = 0 (q88)

All images are resized to square 1024 or 2048 px (the fabric source is
~1:1.002 and was squashed to square; its repeat is unaffected in practice).

| Set | Source | Asset slug | Page | Author(s) | Licence | Downloaded | Real-world size (m) | Mean albedo (1k `color.jpg`) |
|---|---|---|---|---|---|---|---|---|
| `floor-oak` | Poly Haven | `laminate_floor_02` | https://polyhaven.com/a/laminate_floor_02 | Dario Barresi (processing), Charlotte Baglioni (photography) | CC0 | 2026-11-25 | 1.70 x 1.70 | `#9c8063` |
| `floor-pine` | Poly Haven | `wood_planks` | https://polyhaven.com/a/wood_planks | Amal Kumar | CC0 | 2026-11-25 | 1.50 x 1.50 | `#795839` |
| `panel` | Poly Haven | `white_planks_clean` | https://polyhaven.com/a/white_planks_clean | Rob Tuytel | CC0 | 2026-11-25 | 1.80 x 1.80 | `#b5a69d` |
| `plaster` | Poly Haven | `white_plaster_02` | https://polyhaven.com/a/white_plaster_02 | Rob Tuytel | CC0 | 2026-11-25 | 1.00 x 1.00 | `#8e877b` |
| `chipboard` | Poly Haven | `oriented_strand_board` | https://polyhaven.com/a/oriented_strand_board | Dimitrios Savva | CC0 | 2026-11-25 | 2.51 x 2.51 | `#bb9771` |
| `fabric` | Poly Haven | `rough_linen` | https://polyhaven.com/a/rough_linen | colormass (photography), Rico Cilliers (processing) | CC0 | 2026-11-25 | 0.27 x 0.27 | `#91abce` |

Notes for tinting and repeat (Stage 2):

- Texture repeat = 1 / real-world size per metre (for example `floor-oak`
  `repeat = 1 / 1.7` per metre).
- Mean albedo is the sRGB mean of the 1k colour map. `fabric` is blue and
  `plaster` is a mid grey-beige, so tint by `target / meanAlbedo` in linear
  space, or use normal and orm only (map = null) for painted options.
- `panel` boards run vertically (tongue and groove).

## Furniture models (plan 142)

CC0 1.0 from Poly Haven, packed from the 1k glTF variant into self-contained
`.glb` files under `models/` (embedded JPEG textures ≤ 1024 px, no
Draco/meshopt/KTX2 — the CSP blocks their WASM decoders). Normalised: Y-up,
metres, origin at the floor centre of the footprint, front facing +z.
Downloaded 2026-11-25. Bed and wardrobe stay procedural: no CC0 model matched
the style.

| File | Slug / page | Author | Licence | w × h × d (m) | Look |
|---|---|---|---|---|---|
| `sofa-classic.glb` | `Sofa_01` — https://polyhaven.com/a/Sofa_01 | Kirill Sannikov | CC0 | 1.571 × 0.797 × 0.658 | Cream fabric 2-seat sofa, dark wooden legs |
| `desk.glb` | `wooden_table_02` — https://polyhaven.com/a/wooden_table_02 | Serhii Khromov | CC0 | 1.134 × 0.800 × 0.706 | Simple wood slab table on tapered legs |
| `dresser-painted.glb` | `painted_wooden_cabinet` — https://polyhaven.com/a/painted_wooden_cabinet | Kirill Sannikov | CC0 | 1.195 × 1.182 × 0.617 | White painted sideboard, 2 drawers over 2 doors |
| `nightstand.glb` | `painted_wooden_nightstand` — https://polyhaven.com/a/painted_wooden_nightstand | Kirill Sannikov | CC0 | 0.505 × 0.616 × 0.509 | Blue painted bedside table, one drawer |
| `nightstand-light.glb` | `side_table_01` — https://polyhaven.com/a/side_table_01 | James Ray Cock | CC0 | 0.550 × 0.551 × 0.450 | Light-oak open two-shelf side table |
