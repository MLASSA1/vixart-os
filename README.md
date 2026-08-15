# VIXART OS

Système d'exploitation interne de **SOCIETE VIXART SARL** — Agadir.
Remplace les tableurs et la mémoire WhatsApp de l'agence.

| | |
|---|---|
| Raison sociale | SOCIETE VIXART SARL |
| RC | 69627 — Tribunal de Commerce d'Agadir |
| ICE | 003979570000062 |
| IF | 73161069 |
| Activité | Agence de publicité |
| Siège | Bureau AB 403, Imm A9, Technopole II Bensergaou, Agadir |

Mono-organisation, mono-engagement actif (« Monk Mode »). Pas de multi-tenant,
pas de portail client, pas de connexion pour les clients. Cinq comptes, deux
rôles : `admin` (Amin) et `member` (l'équipe).

---

## État d'avancement

| Phase | Contenu | État |
|---|---|---|
| **0** | Fondation : Docker, PostgreSQL, volumes, migrations, sauvegarde/restauration, `money.ts`, `fiscal.ts` | **Terminée** |
| 1 | Authentification + CRM (contacts, WhatsApp, ICE, pipeline, timeline) | à venir |
| 2 | Services + Devis/Factures (numérotation, immuabilité, PDF) | à venir |
| 3 | Projets + Tâches (assignation, pièces jointes) | à venir |
| 4 | Finance + Tableau de bord + Export CSV | à venir |

---

## Installation

Prérequis : **Docker** (ou Colima) et **Node 22+** pour les outils locaux.

```bash
git clone <dépôt> && cd vixart-os
cp .env.example .env          # puis remplacer toutes les valeurs CHANGER_MOI
openssl rand -base64 32       # pour AUTH_SECRET
docker compose up -d --build  # migrations + amorçage automatiques
docker compose logs -f app    # suivre le démarrage
```

L'application écoute sur `http://localhost:${APP_PORT}` (voir `.env`).

> **Note sur le port.** `APP_PORT` vaut `4000` sur ce poste : le port 3000 est
> déjà occupé par le site vitrine visionxart.com en développement. Sur le VPS,
> remettre `APP_PORT=3000`.

Tout le reste passe par `make` :

```bash
make help
```

### Version de Node

Le projet exige **Node 22 ou supérieur** (`engines` dans `package.json`).
Sur ce poste, `node` pointe encore vers une installation manuelle en 20.11 dans
`~/.local/node`. Node 22 est installé via Homebrew mais masqué. Pour l'utiliser :

```bash
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
```

À ajouter dans `~/.zshrc` pour le rendre permanent. Sans cela, `npm test` échoue
avec `does not provide an export named 'styleText'`. Le conteneur Docker embarque
déjà Node 22 : cette contrainte ne concerne que les commandes lancées sur le Mac.

### Comptes de l'équipe

L'amorçage crée cinq comptes avec le mot de passe commun défini par
`SEED_DEFAULT_PASSWORD` dans `.env`. Chacun le change à sa première connexion
(écran disponible en phase 1).

| Adresse | Nom | Rôle |
|---|---|---|
| amin@vixart.ma | Amin — Founder / CEO | admin |
| aymen@vixart.ma | Aymen — Cinematic Director | member |
| azzedine@vixart.ma | Azzedine — Editor & Motion Design | member |
| adam@vixart.ma | Adam — Community & Social Media Manager | member |
| mohamed.amine@vixart.ma | Mohamed Amine — Creative Director & Designer | member |

> Le domaine `@vixart.ma` est une hypothèse. Pour en utiliser un autre, modifier
> `seed/vixart.seed.ts` **avant** le premier démarrage.

---

## Sauvegarde et restauration

> Cette section est écrite pour être suivie sans être développeur.
> Les commandes se tapent dans le Terminal, depuis le dossier du projet.

### Où vivent les données

Trois **volumes Docker nommés**. Ils sont indépendants des conteneurs :
supprimer, reconstruire ou mettre à jour l'application ne les touche pas.

| Volume | Contenu |
|---|---|
| `vixart_pgdata` | Toute la base : clients, documents, finance |
| `vixart_uploads` | Les fichiers joints (pièces jointes, logos, reçus) |
| `vixart_backups` | Les sauvegardes automatiques |

### Ce qui est automatique

Une sauvegarde part **toutes les nuits à 3 h** (heure de Casablanca), plus une
à chaque démarrage de la stack. Les **30 dernières** sont conservées ;
au-delà, la plus ancienne est supprimée automatiquement.

### Voir les sauvegardes existantes

```bash
make backups
```

La plus récente est en bas de la liste. Le nom contient la date et l'heure :
`vixart_2026-08-15_030000.sql.gz` = 15 août 2026 à 03 h 00.

### Lancer une sauvegarde tout de suite

À faire avant toute manipulation risquée.

```bash
make backup
```

### Restaurer une sauvegarde

> ### ⚠️ ATTENTION — OPÉRATION DESTRUCTIVE
> La restauration **écrase la base actuelle**. Tout ce qui a été saisi
> **après** la date de la sauvegarde choisie sera **définitivement perdu**.
> Ne l'utiliser qu'en cas de perte ou de corruption réelle des données.

1. Repérer le fichier à restaurer :

```bash
make backups
```

2. Lancer la restauration avec le nom exact du fichier :

```bash
make restore FILE=vixart_2026-08-15_030000.sql.gz
```

3. Le script affiche un avertissement et demande de taper **`RESTAURER`**
   en majuscules. Toute autre saisie annule sans rien modifier.

**Filet de sécurité :** avant d'écraser quoi que ce soit, le script sauvegarde
automatiquement l'état actuel. Si la restauration était une erreur, l'état
d'avant est le fichier le plus récent dans `make backups`.

### Arrêter l'application sans perdre les données

```bash
make down
```

Les trois volumes restent intacts. `make up` remet tout en marche.

### ⚠️ La commande à ne jamais taper

```
docker compose down -v
```

Le `-v` **détruit les trois volumes** : la base, les fichiers joints **et toutes
les sauvegardes**. Il ne resterait rien à restaurer.

Le `Makefile` n'expose cette opération que sous le nom `make danger-reset`, avec
un avertissement et une confirmation par phrase complète. Elle ne sert qu'à
repartir d'une base totalement vierge sur une machine de test.

### Copier les sauvegardes hors du serveur

Un volume Docker vit sur le même disque que l'application. Si le VPS est perdu,
les sauvegardes le sont aussi. Récupérer une copie sur un autre support :

```bash
docker cp vixart_backup:/backups ./sauvegardes-vixart
```

À faire au moins une fois par mois, vers un disque externe ou un cloud.

---

## Architecture

```
docker-compose.yml     3 services (app, db, backup), 3 volumes nommés
Dockerfile             image applicative Next.js « standalone », Node 22
Makefile               commandes d'exploitation — make help

drizzle/               migrations SQL numérotées (jamais de `push`)
  0000_foundation.sql  tables : app_user, client, fiscal_rate
  0001_foundation_rules.sql  RLS, triggers, contraintes, contexte de session

scripts/
  entrypoint.sh        migrations → privilèges → amorçage → serveur
  migrate.ts           applique les migrations manquantes
  apply-grants.ts      (re)crée le rôle applicatif et ses privilèges
  backup.sh            un dump horodaté + purge au-delà de 30
  backup-daemon.sh     boucle quotidienne du conteneur `backup`
  restore.sh           restauration guidée, avec confirmation

seed/vixart.seed.ts    équipe, pipeline réel, paramètres fiscaux — idempotent

src/
  lib/money.ts         arithmétique en centimes (bigint), format 1 234,56 DH
  lib/fiscal.ts        taux versionnés, calcul HT/TVA/TTC/retenue
  db/schema.ts         schéma Drizzle
  db/index.ts          deux pools : rôle applicatif (RLS) et rôle propriétaire
  app/                 interface Next.js — français, deux couleurs
```

### Deux rôles PostgreSQL, pas un

`vixart_owner` possède les tables et applique les migrations.
`vixart_app` exécute les requêtes de l'application : `NOSUPERUSER`,
`NOBYPASSRLS`, **aucun droit de DDL**. Il ne peut ni créer ni supprimer une
table, et le Row Level Security s'applique réellement à lui.

Toutes les tables sont en `FORCE ROW LEVEL SECURITY` : les politiques valent
même pour le propriétaire. Une erreur de configuration branchant l'application
sur le mauvais rôle ne peut pas ouvrir silencieusement la cloison.

### L'argent ne passe jamais par un flottant

Tout montant est un `BIGINT` de centimes côté base et un `bigint` côté
JavaScript. `src/lib/money.ts` interdit explicitement l'entrée d'un `number`
non entier : `19.99 * 100 === 1998.9999999999998`, et une facture fausse d'un
centime est une facture fausse.

### Les taux fiscaux sont versionnés, jamais modifiés

La table `fiscal_rate` porte une date `effective_from` et un déclencheur qui
**refuse toute modification ou suppression** d'une version existante. Changer un
taux consiste à insérer une nouvelle version datée. Un document déjà émis
conservera le taux copié sur lui-même au moment de l'émission.

> **Retenue à la source (art. 117 bis CGI)** — le taux est amorcé à **0**,
> délibérément. Il dépend de la situation fiscale de VIXART et de chaque client :
> il doit être saisi par Amin sur avis de la fiduciaire, pas deviné. Tant qu'il
> vaut 0, « Net à encaisser » est égal au « Total TTC ».

---

## Tests

```bash
npm test
```

27 tests couvrent l'arithmétique monétaire et le calcul des totaux : arrondis,
pièges du flottant, format français-marocain, TVA à 0 %, retenue à la source.
Les tests de numérotation séquentielle et d'immuabilité des documents arrivent
en phase 2, avec les tables concernées.

---

## Modifier le schéma

```bash
npm run db:generate        # écrit un nouveau fichier numéroté dans drizzle/
# relire le SQL produit avant de l'appliquer
make migrate
```

> Ne jamais lancer `drizzle-kit push` sur la base de production : cette commande
> modifie le schéma sans passer par un fichier versionné et peut supprimer des
> colonnes — donc des données — sans trace.
