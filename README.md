# Hemma·OS

A local-first family operating system. The React SPA is the hub (`/`) linking out to all household tools — calculators, trackers, and shared utilities — as hash routes.

Live at **https://alanvardon.github.io/bostadskalkyl/** (repo rename to `hemma-os` pending).

Tools: Bostadskalkyl · Hushållsbudget · Konsultkalkyl · Månadsavslut · Bolånekoll · Löneväxling

Built with React + Vite + TypeScript. Storage is localStorage behind an async facade, ready to swap for Supabase. The `bostadskalkyl_*` localStorage keys and `bk-assets` build directory are intentionally kept with their legacy prefix — renaming them would break live data.
