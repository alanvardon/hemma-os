# Aurora login backdrop — source & license

- **Footage:** "Time-lapse of aurora borealis over a snow-covered mountain
  and lake at night" (Reine/Hamnøy, Lofoten) by **Cristian Manieri**.
- **Source:** https://www.pexels.com/video/mountain-and-aurora-borealis-11860943/
- **License:** Pexels License — free for commercial/personal use, no
  attribution required, modification allowed.
- **Processing (plan 34):** original 4K 25fps 8.16 s timelapse → scaled to
  1920×1080 → slowed 2× with ffmpeg `minterpolate` (motion-compensated, so
  the accelerated timelapse reads calm) → ping-pong (forward + reversed,
  duplicate mirror frame trimmed) for a seamless 32.4 s loop → H.264
  `crf 22 preset slow`, `+faststart`, no audio. Posters are frame t=4 s as
  JPEG (q3) and AVIF (libaom crf 30).
