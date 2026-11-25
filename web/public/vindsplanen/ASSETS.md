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
