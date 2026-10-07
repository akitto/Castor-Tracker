# Castor Tracker

Estimation, avant son annonce, du prix de souscription Castor du quadrimestre suivant (actionnariat salarié VINCI),
avec un intervalle à 90 %, un indice de fiabilité (IF), la date ou le créneau du conseil d'administration (CA),
le cours VINCI, l'escalier des prix Castor et la plus-value de chaque quadrimestre au cours actuel.

Formule appliquée (avis publiés par VINCI) : **arrondi au centime de 95 % de la moyenne des premiers cours cotés
(ouvertures) des 20 séances Euronext précédant le jour du CA**, jour du CA exclu. Le type de cours, l'arrondi et
l'inclusion du jour du CA restent des paramètres versionnés, tranchés par le backtest au centime.

## Architecture

```
Navigateur (PWA installée)
   │ HTTPS
Proxy Coolify (Traefik, Let's Encrypt)
   ├── castor.<domaine>      → application « web » : PWA statique (Nginx)
   └── api.castor.<domaine>  → service Supabase (modèle Coolify)
                                 ├── Kong → PostgREST (API), GoTrue (auth), Edge Functions
                                 ├── Edge Function castor-jobs (Deno) : collecte, estimation, backtest, accès
                                 └── Postgres : tables + RLS, vues, pg_cron → pg_net → castor-jobs
Sources de cours : Yahoo Finance DG.PA (principale), Euronext Live (contrôle), import CSV (secours)
```

Aucun worker à maintenir : pg_cron déclenche la fonction via pg_net, le back-office l'appelle directement.
Le même moteur de calcul (`packages/core`) sert à la fonction et au simulateur de la PWA.

## Contenu du dépôt

| Chemin | Rôle |
| --- | --- |
| `packages/core` | Moteur TypeScript sans dépendance : calendrier Euronext, formule exacte en entiers, Monte Carlo, IF, backtest, inférence des dates, rejeu, import CSV, lecture Yahoo |
| `apps/web` | PWA React + Vite : tableau de bord, graphique, historique, méthode, back-office ; Dockerfile Nginx |
| `supabase/migrations` | Schéma, RLS, vues, RPC, données de référence, planification pg_cron |
| `supabase/functions/castor-jobs` | Edge Function unique (Deno) |
| `supabase/tests` | Doublures Supabase, tests SQL des droits, test de bout en bout de la fonction |
| `scripts` | Configuration de l'instance, déploiement des fonctions, sauvegarde, tests de base |

## Développement

Prérequis : Node 22, pnpm 10, Postgres 16 (binaires) pour les tests de base, Deno 2 pour la fonction.

```bash
pnpm install
pnpm test:coverage      # moteur : 68 tests, couverture > 90 %
pnpm typecheck
pnpm build              # PWA dans apps/web/dist
pnpm test:db            # migrations rejouées sur un Postgres jetable + 65 tests de droits (REC-10)
pnpm test:functions     # + test de bout en bout de castor-jobs (Deno requis)
pnpm db:types           # régénère packages/core/src/database.ts après une migration
```

PWA en local contre une instance : créer `apps/web/.env.local` avec `VITE_SUPABASE_URL` et `VITE_SUPABASE_ANON_KEY`,
puis `pnpm dev`.

Prix de référence sur cours réels (REC-01) : déposer un export des cours bruts DG.PA (format Euronext ou Yahoo) dans
`packages/core/test/fixtures/dg-pa.csv` ; le test `reference.test.ts` recalcule alors les cinq prix officiels au centime.

## Mise en service sur Coolify

> Ne jamais coller de clé ni de mot de passe dans un chat ou un ticket : les scripts lisent un `.env` local.

### 1. Supabase

1. Coolify › *New resource* › *Service* › **Supabase**.
2. Domaine du service **Kong** : `https://api.castor.<domaine>`. Retirer le domaine public de **Studio** (ou le
   protéger) : Studio ne doit pas être exposé sur Internet.
3. Variables du service d'authentification (éditeur de compose, service `supabase-auth`) :
   - inscriptions fermées : `GOTRUE_DISABLE_SIGNUP=true` (variable `DISABLE_SIGNUP` du modèle) ; garder le
     fournisseur e-mail actif ;
   - `GOTRUE_SITE_URL=https://castor.<domaine>` et `GOTRUE_URI_ALLOW_LIST=https://castor.<domaine>/**` ;
   - SMTP (facultatif mais nécessaire au lien magique et aux invitations par e-mail) ;
   - modèles d'e-mail en français, servis par la PWA (le code à 6 chiffres permet de se connecter depuis
     l'application installée) :
     `GOTRUE_MAILER_TEMPLATES_MAGIC_LINK=https://castor.<domaine>/email/magic-link.html`,
     `GOTRUE_MAILER_TEMPLATES_INVITE=https://castor.<domaine>/email/invite.html`,
     `GOTRUE_MAILER_TEMPLATES_RECOVERY=https://castor.<domaine>/email/recovery.html`.
4. Le service Edge Functions reçoit déjà `SUPABASE_URL` et `SUPABASE_SERVICE_ROLE_KEY` : rien à ajouter.
   La fonction contrôle elle-même ses appels (secret Vault pour pg_cron, JWT admin + TOTP pour le back-office).

### 2. Fonction et base (sur l'hôte Coolify)

```bash
git clone <dépôt> /opt/castor-tracker && cd /opt/castor-tracker
cp .env.example .env && chmod 600 .env   # renseigner les valeurs (clés du service Supabase dans Coolify)
bash scripts/deploy-functions.sh          # copie castor-jobs dans le volume functions et redémarre le service
bash scripts/configure-supabase.sh        # migrations, Vault, pg_cron, premier admin, reprise de l'historique
```

`configure-supabase.sh` est idempotent : il ne rejoue que les migrations nouvelles (suivies dans
`castor_meta.migrations`), crée le secret des tâches planifiées dans Vault (`--rotate-secret` pour le renouveler),
(re)crée les six tâches pg_cron et lance la reprise de l'historique si la base de cours est vide.

### 3. PWA

Coolify › *New resource* › *Application* depuis le dépôt :

- build pack **Dockerfile**, répertoire de base `/`, Dockerfile `apps/web/Dockerfile`, port 80 ;
- domaine `https://castor.<domaine>`, healthcheck `/healthz` ;
- variables d'exécution : `SUPABASE_URL=https://api.castor.<domaine>` et `SUPABASE_ANON_KEY` (clé publique).
  Elles sont écrites dans `/config.js` au démarrage : changer de clé ne demande pas de rebuild.

### 4. Premier lancement (lot 0)

1. Se connecter avec le compte de `ADMIN_EMAIL`, configurer le TOTP (obligatoire pour l'administration).
2. *Admin › Données de cours* : vérifier la reprise de l'historique (≈ 3 000 séances depuis 2015) et le contrôle Euronext.
3. *Admin › Quadrimestres* : importer les prix officiels 2018–2025 (CSV `code;date_ca;prix;avis`).
4. *Admin › Backtest* : lancer le backtest (REC-01 : la variante « ouverture, centime au plus proche, jour du CA
   exclu » doit retrouver tous les prix au centime), l'inférence des dates manquantes, puis le rejeu (REC-05).
5. *Admin › Accès* : inviter les lecteurs (e-mail ou lien à transmettre), choisir la visibilité (restreinte par défaut).

### 5. Sauvegardes (ENF-07)

`scripts/backup.sh` (cron quotidien sur l'hôte) : dump des schémas `public`, `auth` et `castor_meta` vers
`BACKUP_DIR` (NAS), 30 jours de rétention. Restauration à tester sur une instance de test (REC-11).

### 6. Intégration continue

- `.github/workflows/ci.yml` : tests du moteur, typage, build, migrations + tests de droits + test de bout en bout.
- `.github/workflows/deploy.yml` : migrations et déploiement de la fonction sur un runner auto-hébergé du homelab
  (activer avec la variable de dépôt `CASTOR_DEPLOY_ENABLED=true`). Coolify reconstruit la PWA à chaque push.

## Exploitation

### Tâches planifiées (heure de Paris, jours de séance)

| Heure | Tâche | Effet |
| --- | --- | --- |
| 9 h 20 (relance 9 h 40) | `open` | Ouverture du jour, nouvelle estimation |
| toutes les 15 min, 9 h – 17 h 50 | `quote` | Cours en séance (différé 15 min), non journalisé |
| 18 h (relances 18 h 30, 21 h) | `session` | Séance complète, contrôle Euronext, estimation, prix recalculés |
| 7 h 30, tous les jours | `catchup` | Rattrapage des 30 derniers jours, estimation |
| 1er du mois | `maintenance` | Fermetures Euronext de l'année suivante, quadrimestres suivants, purge du journal |

pg_cron compte en UTC : chaque tâche est planifiée aux heures d'été et d'hiver ; la fonction vérifie l'heure de
Paris et l'état de la base pour ne travailler qu'une fois. Les passages sans travail ne sont pas journalisés.

### Gestes courants

| Situation | Geste |
| --- | --- |
| Date du CA connue | *Admin › Quadrimestres › code* : « Date connue » + source → recalcul immédiat |
| Prix officiel annoncé | Même page, « Annonce officielle » : archive l'estimation finale et affiche l'écart |
| Ouverture erronée chez la source | *Données de cours › Corriger une séance* (motif obligatoire, journal d'audit) |
| Source principale en panne | Repli automatique sur Euronext ; sinon import CSV ; alerte après deux échecs |
| Dividende annoncé | *Dividendes et jours fériés* (les détachements passés viennent aussi de Yahoo) |
| Fermeture exceptionnelle d'Euronext | *Dividendes et jours fériés* › jours fériés |
| Règle Castor modifiée | *Paramètres de calcul* › nouvelle version (l'ancienne reste tracée) |
| Point d'accès Euronext modifié | *Accès* › modèle d'URL de l'historique Euronext |
| Secret des tâches compromis | `bash scripts/configure-supabase.sh --rotate-secret` |

### Diagnostic

- Journal des tâches : *Admin › Journal des tâches* (table `job_runs`), audit des écritures admin (`audit_log`).
- Appels pg_net : `select * from net._http_response order by created desc limit 20;`
- Exécutions pg_cron : `select * from cron.job_run_details order by start_time desc limit 20;`
- Fonction : `docker logs <conteneur supabase-edge-functions>` ; santé : `GET /functions/v1/castor-jobs`.

## Sécurité

- RLS sur toutes les tables ; lecture selon la visibilité (publique, restreinte, privée) ; écriture réservée aux
  administrateurs, dont la session doit être validée par TOTP (`aal2`), contrôlé en base (`is_admin()`) et dans la fonction.
- La clé `service_role` reste dans le service des fonctions ; seule la clé `anon` est livrée au navigateur.
- Le secret des tâches planifiées est dans Vault et vérifié en base ; il n'apparaît dans aucun fichier du dépôt.
- Pages non indexées (`robots.txt`, `X-Robots-Tag`, meta), CSP stricte, aucun traceur tiers.

## Écarts avec le cahier des charges

- Les tables vivent dans le schéma `public` de l'instance dédiée (au lieu d'un schéma `castor`) : PostgREST les
  expose sans modifier la configuration du modèle Coolify.
- Table supplémentaire `app_config` : visibilité, TOTP obligatoire, adresse du site, seuil d'alerte, URL Euronext.
- Les tâches lancées depuis le back-office appellent directement la fonction (pas de table de requêtes).
- Alertes visibles dans le back-office en V1 ; notifications Web Push et webhook en V1.1.

## Limites connues

- Yahoo Finance et Euronext Live sont des points d'accès non contractuels : le contrôle croisé, le repli et l'import
  CSV couvrent leurs défaillances ; le backtest au centime valide la source au lot 0.
- L'inférence d'une date de CA peut être ambiguë (deux dates donnant le même prix au centime) : elle n'est alors pas
  appliquée et toutes les dates sont listées.
- Estimation non officielle, pas un conseil en investissement.
