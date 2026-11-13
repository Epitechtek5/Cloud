# Discord : authentification web et Activity

Le front s'exécute de deux façons avec le même code (`app/frontend`) :

| | Navigateur (`web`) | Discord Activity (`activity`) |
|---|---|---|
| Détection | pas dans une iframe, ou pas de `frame_id` | dans une iframe **et** `frame_id` présent (fourni par Discord) |
| Login | redirect OAuth2 (code + PKCE) puis retour sur l'app | `sdk.authorize` → échange → `sdk.authenticate`, sans redirect |
| Réseau | direct | passe par le proxy Discord (`<app_id>.discordsays.com`), voir mappings |
| Token | en mémoire (jamais dans `localStorage`) | en mémoire |

Scope demandé : `identify` uniquement. Il y a **une application Discord par environnement** (dev et prd) : le `client_id` (public) est donc lu au runtime dans `/config.json` (`discordClientId`), jamais figé au build, puisque le même artefact est promu de dev vers prd. Application de dev actuelle : `1562814087900037260`.

## 1. Réglages du Developer Portal (à faire une fois, par application dev/prd)

1. **OAuth2 → Redirects** : ajouter l'URL exacte du front de chaque environnement (et `http://localhost:5173/` pour le dev local). Elle doit être identique au `redirect_uri` envoyé par le front (origine + chemin). C'est l'output `app_url` de la stack `infra/serverless` (`terraform -chdir=infra/serverless output -raw app_url`, avec le `/` final). Sans nom de domaine, son hôte (`<ip>.sslip.io`) change si l'environnement est détruit puis recréé : refaire alors les réglages 1 et 3.
2. **Activities → Settings** : activer les Activities.
3. **Activities → URL Mappings** (chaque hôte externe que le front appelle doit y figurer, car la CSP de l'iframe n'autorise que le proxy Discord) :

| Prefix | Target (sans `https://`) | Usage |
|---|---|---|
| `/` | hôte d'hébergement du front (CDN), l'hôte de `app_url` | pages et assets |
| `/api` | hôte de l'API Gateway (output `gateway_url`, sans `https://`) | `POST /auth/discord`, dessin, etc. |
| `/firestore` | `firestore.googleapis.com` | temps réel (listeners) |
| `/identitytoolkit` | `identitytoolkit.googleapis.com` | connexion Firebase par custom token |
| `/securetoken` | `securetoken.googleapis.com` | rafraîchissement du token Firebase |

Si `apiBase` contient un chemin (`https://gw.example/v1`), il fait partie de la cible du mapping (`gw.example/v1`) : le SDK le retire de l'URL réécrite. Un `apiBase` relatif (`/api`, même origine) est déjà couvert par le mapping `/` et n'a pas d'entrée.

Ces mêmes préfixes sont déclarés dans le code (`src/platform/context.ts`, `activityMappings` et `FIREBASE_HOSTS`) : `patchUrlMappings` du SDK réécrit alors `fetch`, `XMLHttpRequest` et `WebSocket` vers le proxy, sans changer le code appelant. **Les deux listes doivent rester identiques.**

## 2. Contrat attendu de `POST {apiBase}/auth/discord` (équipe `serverless`)

Route **publique** de l'API Gateway (c'est elle qui crée la session), avec throttling.

Requête JSON :

```json
{ "code": "…", "codeVerifier": "…", "redirectUri": "https://…/", "activity": false }
```

- `redirectUri` : seulement pour le flux web, à renvoyer tel quel à Discord.
- `activity: true` : flux Activity (pas de `redirect_uri`).

La fonction doit :

1. Échanger le `code` sur `https://discord.com/api/oauth2/token` avec `client_id`, `client_secret` (**Secret Manager**), `grant_type=authorization_code`, `code_verifier` (PKCE) et, pour le web, `redirect_uri`.
2. Lire l'utilisateur (`GET /users/@me`, scope `identify`) avec l'access token obtenu.
3. Émettre **son propre** jeton court (JWT signé, clé en Secret Manager) contenant l'id Discord, 10 min conseillées.
4. **Ne rien persister** : ni access token, ni refresh token Discord (exigence du sujet).

Réponse 200 :

```json
{ "token": "<jwt>", "expiresIn": 600, "user": { "id": "42", "username": "alice" }, "discordAccessToken": "…" }
```

- `discordAccessToken` : **uniquement si `activity: true`**. Il sert au front pour `sdk.authenticate()` et n'est jamais stocké. Sans lui, l'Activity échoue.
- `firebaseToken` : custom token Firebase (`uid` = id Discord), **seulement si** l'option
  `auth_discord_firebase_custom_token` est activée en Terraform (désactivée par défaut, voir #67).
- Erreur : 4xx/5xx sans détail sensible, corps `{ "error": "<code>" }`. Le front affiche « Login failed (HTTP n) ».
  `400 invalid_request` (corps invalide), `400 invalid_redirect_uri` (absent de l'allow-list), `401 invalid_grant`
  (code refusé par Discord : expiré, déjà utilisé, mauvais verifier), `502 upstream_error` (Discord ou Google indisponible).

Implémentation : fonction `auth-discord` (`app/functions/src/auth-discord`, `infra/serverless/auth_discord.tf`).
Le JWT est signé en **RS256 par le compte de service de la fonction** (IAM Credentials `signJwt`), sans clé à nous ;
claims `iss`, `aud`, `sub` (id Discord), `username`, `iat`, `exp`, `jti`. La gateway le vérifie avec les clés
publiques que Google publie pour ce compte (`x-google-jwks_uri`, voir `infra/serverless/README.md`, « API Gateway »).
Le `redirectUri` doit figurer **exactement** dans `auth_discord_redirect_uris`
(par environnement), dont les origines servent aussi d'allow-list CORS.

Le front envoie ensuite `Authorization: Bearer <token>` sur tous les appels ; la gateway valide le JWT. Il propage aussi `X-Correlation-Id`.

## 3. Tester

- **Mock, sans Discord ni cloud** : `npm run dev` (utilisateur factice `dev-user`).
- **Web contre les vrais services** : `BACKEND=gcp npm run dev`, avec un `/config.json` servi (`env`, `apiBase`, `discordClientId`, `firebase`, voir `src/runtimeConfig.ts` ; `apiBase` sans `/` final).
- **Activity en local** : lancer un tunnel public (`cloudflared tunnel --url http://localhost:5173`), mettre l'hôte du tunnel en cible du mapping `/` dans le portail, activer le mode développeur Discord, puis lancer l'Activity depuis un salon vocal (Activities). Une Activity non publiée n'est lançable que par les membres de l'équipe de l'application.

## 4. Point à valider : Firestore dans l'iframe

Le temps réel Firestore passe par `fetch`/XHR (et WebChannel) vers `firestore.googleapis.com`. Avec les mappings ci-dessus et `patchUrlMappings`, il devrait être routé par le proxy, mais **cela doit être testé dans une vraie Activity** (flux long, reconnexions). Si cela ne tient pas, le plan B est un flux SSE ou WebSocket exposé par notre propre endpoint, derrière l'interface `RealtimeChannel` (aucun autre changement côté UI).

## 5. Comportements à connaître

- **Hors de Discord** : si la page est ouverte dans un onglet normal (même avec `?frame_id=`), elle reste en mode web. Dans une iframe qui n'est pas Discord, la poignée de main expire après 15 s avec « Open this app from a voice channel in Discord ».
- **Logout (web)** : l'application oublie la session (elle n'existe qu'en mémoire) mais **ne déconnecte pas de Discord**. Discord mémorise le consentement : un nouveau clic sur « Login with Discord » reconnecte aussitôt le même compte. Pour changer de compte, se déconnecter de discord.com.
- **Après le login**, la query et le hash d'origine (`?debug`, liens directs) sont restaurés.

## 6. Sécurité (ce qui est en place et testé)

- `state` aléatoire vérifié au retour (un callback non initié est rejeté avant tout appel réseau) ; PKCE S256 ; `state` et verifier à usage unique, supprimés aussi quand Discord renvoie `?error=`.
- Dans l'Activity, `fetch` est résolu à chaque appel : `patchUrlMappings` remplace `window.fetch`, une référence prise avant contournerait le proxy.
- Token jamais écrit dans `localStorage` ni `sessionStorage`.
- Scope minimal `identify` ; aucune clé ni secret côté front.
- SDK Discord chargé à la demande, uniquement dans l'Activity.
