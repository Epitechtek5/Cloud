# Frontend — Pixel Canvas

Canvas 100 000 × 100 000 temps réel (≈ 153 000 tuiles de 256×256, chargées à la demande), utilisable en web et en Discord Activity.
Vite + TypeScript, rendu Canvas 2D, aucune dépendance runtime.

## Commandes

```sh
npm install
npm run dev        # backend mock en navigateur, aucun cloud requis
npm run lint && npm run typecheck && npm test
npm run build      # un seul artefact, promu dev → prd par la CI (services GCP réels)
```

## Architecture

- `src/contract.ts` : contrat front/backend (`TileSource`, `RealtimeChannel`, `Api`).
  Le mock (`src/backend/mock.ts`) et l'implémentation GCP sont interchangeables.
- `src/canvas/` : géométrie viewport, `TileManager` (tuiles 256×256), rendu, contrôles.
- `src/ui/hud.ts` : coordonnées, « aller à », inspecteur de pixel, overlay debug (touche `d`).

## Dessin

- Outils : **Inspect** (`V`, clic = sélection + « Paint this pixel ») et **Brush** (`B`, taille `[` / `]`, 1 à 32).
  En mode brush : glisser dessine ; déplacement avec clic milieu/droit, `Espace`+glisser ou deux doigts.
- Un trait est interpolé (Bresenham), dédupliqué, regroupé (~100 ms) puis envoyé par lots de 256 px max
  via `Api.draw(pixels, batchId)` (gateway → proxy → broker). Jamais d'écriture directe dans le stockage.
- Rendu optimiste (`DrawController.pending`) : le pixel s'affiche tout de suite, puis l'écho temps réel le remplace.
  Rejeté (quota, pause) ou sans réponse sous 15 s : il disparaît avec un message.
- Mock : limite de 20 px/min par défaut ; `?limit=1000` dans l'URL ou `__mock.setLimit(n)` / `__mock.setPaused(true)` en console.

## Règles clés

- **Pas de polling** : `setInterval` est interdit par ESLint (sauf dans le mock qui simule
  des utilisateurs distants). Le canvas ne se met à jour que par événements.
- Une tuile en cache est toujours abonnée au temps réel ; sortir du viewport (+1 tuile de marge)
  supprime le raster **et** l'abonnement, donc le cache n'est jamais périmé.
- Le mock est exclu des bundles `dev`/`prd` (tree-shaking via `__BACKEND__`).
- Aucun secret côté front : seul le `client_id` Discord (public) est injecté au build.
- **Build once, deploy everywhere** (cf. `deploy-env.yml`) : le build ne contient rien de spécifique
  à un environnement. L'URL de l'API Gateway et la config Firebase sont lues au runtime dans
  `/config.json` (voir `src/runtimeConfig.ts`), à générer depuis la stack Terraform `serverless`.
  Le mock n'est actif que pour `npm run dev`.

## Limite connue

Zoom arrière plafonné à 0,5× (≈ 100 tuiles) : à cette échelle on voit ~1 % de la largeur de la grille.
Une couche d'aperçu sous-échantillonnée (mini-map) devient nécessaire pour s'y repérer ; en attendant,
le formulaire « aller à (x, y) » permet de se téléporter.
