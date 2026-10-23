# Hands-on 1 — VPC + subnet avec Terraform (GCP, env dev)

> Support : **C02 – Infrastructure as Code with Terraform**
> Objectif : une infra **reproductible** (1 commande pour créer) et **jetable** (1 commande pour détruire), avec un **state distant** dans un bucket GCS.

Ce document explique **ce qui a été fait, dans quel ordre, et pourquoi**. Il est fait pour qu'on puisse le relire et refaire le hands-on de zéro, mais surtout pour qu'on puisse l'expliquer à la soutenance.

---

## 0. TL;DR — refaire tout le hands-on

```bash
# 1. Une seule fois : créer le bucket de state (et activer les API)
bash scripts/bootstrap-state-bucket.sh sage-inquiry-512409-h3 huiledecloud-dev-tfstate europe-west1

# 2. Le workflow Terraform
cd infra/foundation
terraform init -backend-config=backends/dev.hcl
terraform fmt -check && terraform validate
terraform plan  -var-file=dev.tfvars
terraform apply -var-file=dev.tfvars

# 3. Tout supprimer
terraform destroy -var-file=dev.tfvars
```

Pour prd, c'est le même code : on remplace `dev` par `prd` partout et on ajoute `-reconfigure` à l'`init` (voir §7).

---

## 1. Les notions à comprendre avant tout

### 1.1 Déclaratif vs impératif

Avec un script `gcloud`, on écrit **les actions** : « crée un réseau, puis crée un subnet ». Si on relance, ça plante (« already exists »).

Avec Terraform on écrit **l'état voulu** : « il doit exister un réseau X et un subnet Y ». Terraform compare cet état voulu à la réalité et calcule lui‑même les actions. C'est ce qui donne les trois propriétés du cours :

| Propriété | Ce que ça veut dire concrètement | Comment on l'a vérifié |
|---|---|---|
| **Reproductibilité** | Même code + mêmes variables = même infra | `destroy` puis `apply` → le VPC et le subnet sont recréés à l'identique (mêmes noms, même `10.0.1.0/24`) |
| **Idempotence** | Relancer ne change rien si rien n'a bougé ; si quelqu'un modifie à la main dans la console, le prochain `apply` remet l'état voulu | Un 2ᵉ `plan` juste après l'`apply` répond *« No changes »* |
| **Versioning** | Le code est dans Git, relu en PR, réversible | Les fichiers `.tf` sont commités, le state ne l'est jamais |

### 1.2 Les 4 pièces de Terraform

```
  code .tf (état voulu)
        │
        ▼
  terraform plan   ──►  compare  code  vs  state  vs  réalité (API GCP)
        │                         → liste de +créer / ~modifier / -détruire
        ▼
  terraform apply  ──►  le provider "google" appelle les API GCP
        │
        ▼
  state mis à jour (dans le bucket GCS)
```

- **Provider** : plugin qui sait parler à une API (ici `hashicorp/google`). C'est lui qui fournit les types de ressources (`google_compute_network`, ...).
- **State** : la *mémoire* de Terraform. Un fichier JSON qui dit « la ressource `google_compute_network.main` de mon code = le réseau `projects/.../networks/huiledecloud-dev-vpc` dans GCP ». Sans lui, Terraform ne saurait pas qu'il a déjà créé le réseau et essaierait de le recréer.
- **Plan** : le diff entre l'état voulu et l'état réel.
- **Apply** : l'exécution de ce diff.

### 1.3 Pourquoi un state *distant* ?

Par défaut, le state est un fichier `terraform.tfstate` local. Problèmes en équipe :

- chacun a sa propre copie → deux personnes pensent chacune être la référence ;
- deux `apply` en même temps → state corrompu ;
- le fichier peut contenir des secrets → il ne doit **jamais** aller dans Git.

Avec un backend **GCS** (un bucket Google Cloud Storage) :

- le state est partagé par toute l'équipe et la CI ;
- un **verrou** (`.tflock`) est posé automatiquement pendant `plan`/`apply` → impossible de lancer deux opérations en parallèle sur le même state ;
- on a activé le **versioning** du bucket → si le state est cassé, on peut revenir à une version précédente.

### 1.4 Le problème de la poule et de l'œuf

Le bucket qui stocke le state doit **exister avant** `terraform init`. Il ne peut donc pas être créé par la stack qui l'utilise. C'est pour ça qu'on le crée avec un petit script (étape 2 ci‑dessous). Le cours demande ensuite de le passer sous contrôle Terraform avec `terraform import` — voir §6.

---

## 2. Particularités GCP à connaître

### 2.1 ID de projet ≠ nom de projet

```
PROJECT_ID                    NAME
sage-inquiry-512409-h3        huiledecloud-cloudnative-dev   ← dev
huiledecloud-cloudnative-prd  huiledecloud-cloudnative-prd   ← prd
```

Le projet dev a été créé avec un **ID auto‑généré** (`sage-inquiry-512409-h3`) ; `huiledecloud-cloudnative-dev` n'est que son **nom d'affichage**. Toutes les API (et donc Terraform) attendent l'**ID**. C'est pour ça que `dev.tfvars` contient `sage-inquiry-512409-h3`.

> ⚠️ `gcloud config list` montre `project = huiledecloud-cloudnative-dev` : c'est le nom, pas l'ID, donc les commandes `gcloud` sans `--project` risquent d'échouer. À corriger avec :
> ```bash
> gcloud config set project sage-inquiry-512409-h3
> ```

### 2.2 Un VPC GCP n'a pas de CIDR

Sur AWS, un VPC a un `cidr_block` (ex. `10.0.0.0/16`) et les subnets sont pris dedans.
Sur GCP, un **VPC est global et n'a pas de plage IP** : seuls les **subnets** (régionaux) en ont une.

Pour garder la même variable `cidr_block` que dans le cours, on la traite comme **l'enveloppe réservée à l'environnement**, et on calcule le subnet dedans avec `cidrsubnet()` :

```hcl
ip_cidr_range = cidrsubnet(var.cidr_block, 8, 1)
#               cidrsubnet("10.0.0.0/16", 8, 1)
#               /16 + 8 bits = /24, et on prend le n°1 → 10.0.1.0/24
```

Avantage : si on change `cidr_block` en `10.1.0.0/16` pour prd, le subnet devient automatiquement `10.1.1.0/24`. Rien n'est codé en dur.

### 2.3 Le réseau `default`

Quand on active l'API Compute, GCP crée tout seul un réseau `default` (mode AUTO, un subnet par région, règles firewall permissives). Il **n'est pas géré par Terraform** et c'est normal qu'il reste après `destroy`. Un VPC en lui‑même n'est pas facturé, mais pour une infra propre on pourra le supprimer plus tard (et l'empêcher via la contrainte d'organisation `compute.skipDefaultNetworkCreation` si un jour on a une organisation).

---

## 3. Ce qui a été fait, étape par étape

### Étape 1 — Créer le bucket de state : `scripts/bootstrap-state-bucket.sh`

```bash
bash scripts/bootstrap-state-bucket.sh sage-inquiry-512409-h3 huiledecloud-dev-tfstate europe-west1
```

Ce que fait le script :

1. **Active les API** `storage` et `compute` sur le projet (sans `compute`, impossible de créer un réseau : erreur 403 *API not enabled*).
2. **Crée le bucket** `gs://huiledecloud-dev-tfstate` en `europe-west1` s'il n'existe pas déjà (le script est idempotent, on peut le relancer) avec :
   - `--uniform-bucket-level-access` : les droits se gèrent uniquement par IAM, pas fichier par fichier ;
   - `--public-access-prevention` : le bucket ne peut jamais devenir public (le state peut contenir des infos sensibles).
3. **Active le versioning** pour pouvoir restaurer une ancienne version du state :
   ```bash
   gcloud storage buckets update "gs://${BUCKET}" --versioning
   ```
   Cette commande est séparée de la création et s'exécute **à chaque lancement** du script : même si le bucket existait déjà (ou a été créé autrement), le versioning est garanti.

   Concrètement, chaque `apply`/`destroy` réécrit `default.tfstate` ; GCS garde l'ancienne version comme version « non courante », identifiée par un numéro de génération (après le `#`) :
   ```bash
   gcloud storage buckets describe gs://huiledecloud-dev-tfstate --format="value(versioning_enabled)"   # → True
   gcloud storage ls -a gs://huiledecloud-dev-tfstate/foundation/
   # gs://huiledecloud-dev-tfstate/foundation/default.tfstate#1792677009692055
   # gs://huiledecloud-dev-tfstate/foundation/default.tfstate#1792677098189797
   # ...
   ```
   Pour restaurer une version (state corrompu, mauvaise manip) :
   ```bash
   gcloud storage cp "gs://huiledecloud-dev-tfstate/foundation/default.tfstate#<GENERATION>" \
                      gs://huiledecloud-dev-tfstate/foundation/default.tfstate
   ```
   > Les anciennes versions ne sont jamais supprimées automatiquement (les `.tflock` sont versionnés aussi). C'est négligeable (quelques Ko), mais une règle de *lifecycle* pour les purger sera ajoutée lors de l'import du bucket dans Terraform (§6).

> Les noms de bucket sont **globaux** à tout GCP (tous clients confondus), d'où le préfixe `huiledecloud-`.

> 💡 Sous Git Bash sur Windows, `gcloud` peut afficher *« Python was not found »*. Il faut lui indiquer le Python embarqué du SDK :
> ```bash
> export CLOUDSDK_PYTHON="/c/Users/neyma/AppData/Local/Google/Cloud SDK/google-cloud-sdk/platform/bundledpython/python.exe"
> ```
> (En PowerShell, `gcloud` marche directement.)

### Étape 2 — Les fichiers Terraform (`infra/foundation/`)

```
infra/foundation/
├── providers.tf         # version de Terraform + provider google
├── variables.tf         # déclaration des entrées
├── main.tf              # les ressources : VPC + subnet
├── outputs.tf           # ce que la stack expose après apply
├── backend.tf           # "le state est dans GCS" (sans détails)
├── backends/
│   ├── dev.hcl          # les détails du backend pour dev
│   └── prd.hcl          # ... et pour prd (§7)
├── dev.tfvars           # les valeurs des variables pour dev
├── prd.tfvars           # ... et pour prd (§7)
└── .terraform.lock.hcl  # versions exactes des providers (généré, à commiter)
```

Terraform lit **tous les `.tf` du dossier** comme un seul bloc : le découpage en fichiers est une convention de lisibilité, pas une obligation.

#### `providers.tf`

```hcl
terraform {
  required_version = ">= 1.9"
  required_providers {
    google = { source = "hashicorp/google", version = "~> 7.0" }
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}
```

- `required_version` : refuse de tourner avec un Terraform trop vieux.
- `~> 7.0` : accepte 7.x mais pas 8.0 → on reçoit les correctifs sans risquer une version majeure qui casse tout.
- Le bloc `provider` donne le projet et la région **par défaut** à toutes les ressources google. Pas d'identifiants ici : l'authentification passe par `gcloud auth application-default login` (en local) et plus tard par Workload Identity en CI (C03). **Jamais de clé JSON dans le code.**

#### `variables.tf`

Déclare 4 variables : `project_id`, `region`, `vpc_name`, `cidr_block`. Chacune a un `type` et une `description`. Pas de valeur par défaut volontairement : si on oublie le `-var-file`, Terraform demande les valeurs au lieu d'utiliser silencieusement une mauvaise valeur.

`cidr_block` a en plus une **validation** :

```hcl
validation {
  condition     = can(cidrhost(var.cidr_block, 0))
  error_message = "cidr_block must be a valid CIDR, e.g. 10.0.0.0/16."
}
```

→ une faute de frappe (`10.0.0/16`) est refusée dès le `plan`, avant d'appeler GCP.

#### `main.tf`

```hcl
resource "google_compute_network" "main" {
  name                    = var.vpc_name
  auto_create_subnetworks = false
  routing_mode            = "REGIONAL"
}

resource "google_compute_subnetwork" "main" {
  name          = "${var.vpc_name}-subnet"
  network       = google_compute_network.main.id
  region        = var.region
  ip_cidr_range = cidrsubnet(var.cidr_block, 8, 1)

  private_ip_google_access = true
}
```

Lecture d'une ligne `resource "TYPE" "NOM_LOCAL"` : `TYPE` est fourni par le provider (doc sur le Terraform Registry), `NOM_LOCAL` est le nom *dans notre code* (pas dans GCP). On le référence ailleurs avec `TYPE.NOM_LOCAL.attribut`.

- `auto_create_subnetworks = false` : mode **custom**. Sinon GCP crée un subnet dans chaque région avec des plages imposées — on perd le contrôle des IP.
- `routing_mode = "REGIONAL"` : les routes apprises par un futur Cloud Router ne sont annoncées que dans sa région (c'est le défaut, mais on l'écrit pour que ce soit explicite).
- `private_ip_google_access = true` : les VM/nœuds **sans IP publique** pourront quand même joindre les API Google (Artifact Registry, Cloud Storage...). Indispensable pour le cluster GKE privé de C04.

**Dépendances** : `network = google_compute_network.main.id` est une *référence*. Terraform en déduit qu'il doit créer le VPC **avant** le subnet (et le détruire **après**). On le voit dans la sortie de l'apply : le réseau est créé, puis le subnet. Aucun `depends_on` n'est nécessaire.

#### `outputs.tf`

Expose `vpc_id`, `subnet_id`, `subnet_cidr` après l'apply. Utile pour lire le résultat (`terraform output vpc_id`) et, plus tard, pour que d'autres stacks (serverless) récupèrent l'ID du réseau.

#### `backend.tf` + `backends/dev.hcl`

```hcl
# backend.tf
terraform {
  backend "gcs" {}
}
```
```hcl
# backends/dev.hcl
bucket = "huiledecloud-dev-tfstate"
prefix = "foundation"
```

Un bloc `backend` **ne peut pas utiliser de variables** (il est lu avant que les variables existent). On laisse donc le bloc vide et on fournit les valeurs à l'`init` via `-backend-config=backends/dev.hcl`. Pour prd, il suffira d'un `backends/prd.hcl` pointant vers un autre bucket : **même code, autre state**.

Le `prefix` est le « dossier » dans le bucket. Le state se retrouve dans `gs://huiledecloud-dev-tfstate/foundation/default.tfstate` (`default` = nom du workspace Terraform par défaut). La future stack serverless utilisera un autre prefix dans le même bucket.

#### `dev.tfvars`

```hcl
project_id = "sage-inquiry-512409-h3" # display name: huiledecloud-cloudnative-dev
region     = "europe-west1"
vpc_name   = "huiledecloud-dev-vpc"
cidr_block = "10.0.0.0/16"
```

Les **valeurs** pour l'environnement dev. `europe-west1` (Belgique) : région proche, peu chère, et qui a tous les services dont on aura besoin. Ce fichier ne contient **aucun secret** et peut donc être commité.

### Étape 3 — Le workflow

Toutes les commandes se lancent depuis `infra/foundation/`.

| Commande | Ce qu'elle fait | Ce qu'on a obtenu |
|---|---|---|
| `terraform init -backend-config=backends/dev.hcl` | Télécharge le provider google dans `.terraform/`, crée `.terraform.lock.hcl`, se connecte au bucket de state | *Terraform has been successfully initialized!* |
| `terraform fmt -check` | Vérifie le formatage (indentation, alignement des `=`). Ne modifie rien ; sans `-check` il corrige | Aucune sortie = OK |
| `terraform validate` | Vérifie la syntaxe et la cohérence (types, références) **sans** appeler GCP | *Success! The configuration is valid.* |
| `terraform plan -var-file=dev.tfvars` | Calcule le diff | **`Plan: 2 to add, 0 to change, 0 to destroy.`** → exactement le VPC + le subnet |
| `terraform apply -var-file=dev.tfvars` | Réaffiche le plan, demande `yes`, exécute | *Apply complete! Resources: 2 added* (≈ 25 s pour le subnet) |

Lecture du plan : `+` = créer, `~` = modifier sur place, `-` = détruire, `-/+` = détruire puis recréer (attention à ces lignes‑là en prod !). `(known after apply)` = valeur que seul GCP connaîtra (ID, self_link...).

Outputs obtenus :

```
subnet_cidr = "10.0.1.0/24"
subnet_id   = "projects/sage-inquiry-512409-h3/regions/europe-west1/subnetworks/huiledecloud-dev-vpc-subnet"
vpc_id      = "projects/sage-inquiry-512409-h3/global/networks/huiledecloud-dev-vpc"
```

On remarque `global/networks` pour le VPC et `regions/europe-west1/subnetworks` pour le subnet : c'est la différence global/régional du §2.2.

### Étape 4 — Vérifier dans GCP

Console : *VPC network → VPC networks* → `huiledecloud-dev-vpc`, onglet *Subnets*. Ou en CLI :

```bash
gcloud compute networks list --project sage-inquiry-512409-h3
gcloud compute networks subnets list --project sage-inquiry-512409-h3 --filter="network~huiledecloud"
gcloud storage ls gs://huiledecloud-dev-tfstate/foundation/     # le state distant
terraform output vpc_id
```

Résultat observé : `huiledecloud-dev-vpc` en mode `CUSTOM`, subnet `huiledecloud-dev-vpc-subnet` en `europe-west1` avec `10.0.1.0/24`, et le fichier `foundation/default.tfstate` dans le bucket.

**Test d'idempotence** : relancer `terraform plan` juste après → *« No changes. Your infrastructure matches the configuration. »*

### Étape 5 — Détruire

```bash
terraform destroy -var-file=dev.tfvars
```

→ *Destroy complete! Resources: 2 destroyed.* Terraform détruit dans l'ordre inverse : le subnet d'abord, puis le VPC (un VPC qui contient encore un subnet ne peut pas être supprimé).

Vérification : `gcloud compute networks list` ne montre plus que `default` (cf. §2.3), et la liste des subnets `huiledecloud` est vide.

### Étape 6 — Re‑créer pour prouver la reproductibilité

On a refait `apply` après le `destroy` : mêmes 2 ressources, mêmes noms, mêmes IDs, même plage, **sans aucune étape manuelle**. Puis `destroy` à nouveau pour ne rien laisser tourner.

**État final** : VPC et subnet détruits. Il ne reste que le bucket de state (quelques Ko, coût négligeable) — c'est voulu, il doit survivre aux `destroy`.

---

## 4. Critères d'acceptation

| Critère du sujet | Statut |
|---|---|
| `apply` crée **exactement** VPC + subnet | ✅ `Plan: 2 to add` |
| State distant | ✅ `gs://huiledecloud-dev-tfstate/foundation/default.tfstate` |
| `destroy` supprime tout | ✅ `2 destroyed`, rien dans `gcloud ... list` |
| Ré‑`apply` recrée à l'identique sans étape manuelle | ✅ testé |
| Ni state ni credentials dans Git | ✅ `.gitignore` (`*.tfstate`, `.terraform/`, `*.json`, `.env`, ...) |
| *Go further* : même code pour dev et prd (autre région, autre CIDR, autre backend) | ✅ voir §7 |

---

## 5. Ce qui va / ne va pas dans Git

| ✅ À commiter | ❌ Jamais |
|---|---|
| `*.tf`, `*.tfvars` (sans secrets), `backends/*.hcl` | `*.tfstate`, `*.tfstate.backup` |
| `.terraform.lock.hcl` (garantit les mêmes versions de provider pour tout le monde et la CI) | `.terraform/` (binaires du provider, ~100 Mo, se re‑télécharge avec `init`) |
| `scripts/bootstrap-state-bucket.sh` | clés de service account `*.json`, `.env` |

---

## 6. Suite : importer le bucket dans Terraform

Le cours demande de passer le bucket sous contrôle Terraform avec `terraform import`. **Pas dans la stack `foundation`** : sinon `terraform destroy` essaierait de supprimer le bucket qui contient… son propre state. Il ira dans la stack séparée `infra/access/` (accès humains, C03), qui elle n'est pas détruite à chaque fois. Le principe :

```hcl
resource "google_storage_bucket" "tfstate" {
  name                        = "huiledecloud-dev-tfstate"
  location                    = "EUROPE-WEST1"
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  versioning { enabled = true }

  # purge les anciennes versions : on garde les 10 dernières, max 30 jours
  lifecycle_rule {
    condition {
      num_newer_versions = 10
      with_state         = "ARCHIVED"
    }
    action { type = "Delete" }
  }
  lifecycle_rule {
    condition {
      days_since_noncurrent_time = 30
      with_state                 = "ARCHIVED"
    }
    action { type = "Delete" }
  }

  lifecycle { prevent_destroy = true }
}
```

> Attention à ne pas confondre `lifecycle_rule` (règle **GCS** qui supprime de vieux objets) et `lifecycle { prevent_destroy }` (méta‑argument **Terraform** qui refuse tout `destroy` de cette ressource).
```bash
terraform import -var-file=dev.tfvars google_storage_bucket.tfstate huiledecloud-dev-tfstate
terraform plan -var-file=dev.tfvars   # doit afficher "No changes"
```

`import` n'écrit pas de code : il ajoute juste la ressource existante dans le state. Le `plan` qui suit doit être vide, sinon c'est que le code ne décrit pas exactement le bucket réel.

## 7. Go further : le même code pour dev **et** prd

Le but : prouver que **le code ne dépend pas de l'environnement**. Aucun `.tf` n'a été modifié ; on a seulement ajouté deux petits fichiers de *valeurs*.

### 7.1 Ce qui change entre dev et prd

| | dev | prd |
|---|---|---|
| Projet GCP (ID) | `sage-inquiry-512409-h3` | `huiledecloud-cloudnative-prd` |
| Région | `europe-west1` (Belgique) | `europe-west9` (Paris) |
| `cidr_block` | `10.0.0.0/16` | `10.1.0.0/16` |
| Subnet calculé | `10.0.1.0/24` | `10.1.1.0/24` |
| VPC | `huiledecloud-dev-vpc` | `huiledecloud-prd-vpc` |
| Bucket de state | `huiledecloud-dev-tfstate` | `huiledecloud-prd-tfstate` |
| Fichiers | `dev.tfvars` + `backends/dev.hcl` | `prd.tfvars` + `backends/prd.hcl` |

```hcl
# prd.tfvars
project_id = "huiledecloud-cloudnative-prd"
region     = "europe-west9"
vpc_name   = "huiledecloud-prd-vpc"
cidr_block = "10.1.0.0/16"
```
```hcl
# backends/prd.hcl
bucket = "huiledecloud-prd-tfstate"
prefix = "foundation"
```

**Pourquoi des CIDR différents ?** Les deux réseaux sont isolés (projets différents), donc des plages identiques marcheraient aujourd'hui. Mais si un jour on veut les relier (VPC peering, VPN), des plages qui se chevauchent rendent la connexion impossible. Choisir des plages disjointes dès le départ coûte zéro et évite ce piège.

**Pourquoi un bucket de state par environnement ?** Isolation totale : une erreur en dev (state cassé, mauvais `destroy`) ne peut pas toucher prd, et plus tard on pourra donner à la CI de dev des droits sur le bucket dev seulement (C03).

### 7.2 Les commandes

```bash
# une seule fois : bucket prd (active aussi l'API Compute sur le projet prd)
bash scripts/bootstrap-state-bucket.sh huiledecloud-cloudnative-prd huiledecloud-prd-tfstate europe-west9

cd infra/foundation
terraform init -reconfigure -backend-config=backends/prd.hcl
terraform plan    -var-file=prd.tfvars
terraform apply   -var-file=prd.tfvars
terraform destroy -var-file=prd.tfvars

# revenir sur dev
terraform init -reconfigure -backend-config=backends/dev.hcl
```

**`-reconfigure` est indispensable.** Le dossier `.terraform/` retient le backend du dernier `init`. Sans `-reconfigure`, Terraform voit que la config a changé et propose de **migrer** le state dev vers le bucket prd, ce qui est exactement ce qu'on ne veut pas. `-reconfigure` dit simplement : « oublie l'ancien backend, branche‑toi sur celui‑ci ».

> ⚠️ Le piège classique : faire `init` sur prd puis `apply -var-file=dev.tfvars` (ou l'inverse). Terraform utiliserait le state prd avec les valeurs dev. **Toujours vérifier que le `.hcl` et le `.tfvars` correspondent au même environnement.** En CI (C03), une matrice `env: [dev, prd]` qui utilise `backends/${env}.hcl` et `${env}.tfvars` élimine ce risque.

### 7.3 Ce qu'on a obtenu en prd

- `plan` → `Plan: 2 to add`, avec `project = huiledecloud-cloudnative-prd`, `region = europe-west9`, `ip_cidr_range = 10.1.1.0/24`
- `apply` →
  ```
  vpc_id      = "projects/huiledecloud-cloudnative-prd/global/networks/huiledecloud-prd-vpc"
  subnet_id   = "projects/huiledecloud-cloudnative-prd/regions/europe-west9/subnetworks/huiledecloud-prd-vpc-subnet"
  subnet_cidr = "10.1.1.0/24"
  ```
- state dans `gs://huiledecloud-prd-tfstate/foundation/default.tfstate`
- second `plan` → *No changes*
- `destroy` → `2 destroyed` ; il ne reste que le réseau `default` du projet
- retour sur dev : `plan` → `2 to add`, ce qui prouve que le state dev est resté **séparé et intact** (dev était détruit, il voit donc bien 2 ressources à créer, et pas les ressources prd)

C'est le pont vers C03 : la CI lancera exactement ces commandes, avec l'environnement en paramètre.

---

## 8. Erreurs fréquentes

| Symptôme | Cause | Solution |
|---|---|---|
| `Error 403: Compute Engine API has not been used in project ...` | API pas activée | `gcloud services enable compute.googleapis.com --project <ID>` (fait par le script) |
| `Failed to get existing workspaces: bucket doesn't exist` à l'`init` | Bucket de state pas encore créé | Lancer le script de bootstrap |
| `Error 404 ... project huiledecloud-cloudnative-dev` | Nom du projet utilisé au lieu de l'ID | Utiliser `sage-inquiry-512409-h3` |
| `could not find default credentials` | ADC absentes | `gcloud auth application-default login` |
| `Error acquiring the state lock` | Une autre opération est en cours (ou a crashé) | Attendre ; si sûr qu'il n'y a rien d'autre : `terraform force-unlock <LOCK_ID>` |
| `Backend configuration changed` | Changement de `.hcl` | `terraform init -reconfigure -backend-config=...` |
