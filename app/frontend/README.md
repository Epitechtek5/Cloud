# Frontend — Pixel Canvas

Canvas 10000×10000 temps réel, utilisable en web et en Discord Activity.
Vite + TypeScript, rendu Canvas 2D, aucune dépendance runtime.

## Commandes

```sh
npm install
npm run dev        # backend mock en navigateur, aucun cloud requis
npm run lint && npm run typecheck && npm test
npm run build:dev  # / build:prd  → cible le backend GCP
```

## Architecture

- `src/contract.ts` : contrat front/backend (`TileSource`, `RealtimeChannel`, `Api`).
  Le mock (`src/backend/mock.ts`) et l'implémentation GCP sont interchangeables.
- `src/canvas/` : géométrie viewport, `TileManager` (tuiles 256×256), rendu, contrôles.
- `src/ui/hud.ts` : coordonnées, « aller à », inspecteur de pixel, overlay debug (touche `d`).

## Règles clés

- **Pas de polling** : `setInterval` est interdit par ESLint (sauf dans le mock qui simule
  des utilisateurs distants). Le canvas ne se met à jour que par événements.
- Une tuile en cache est toujours abonnée au temps réel ; sortir du viewport (+1 tuile de marge)
  supprime le raster **et** l'abonnement, donc le cache n'est jamais périmé.
- Le mock est exclu des bundles `dev`/`prd` (tree-shaking via `__BACKEND__`).
- Aucun secret côté front : seul le `client_id` Discord (public) est injecté au build.

## Limite connue

Zoom arrière plafonné à 0,5× (≈ 100 tuiles) ; une couche d'aperçu sous-échantillonnée
permettrait de voir la grille entière.
