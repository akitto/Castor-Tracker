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

Pour les essais, la partie Supabase peut être un projet Supabase Cloud au lieu du service Coolify (voir « Mise en service »).

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
| `deploy` | Installation sur Supabase Cloud par copier-coller : base (SQL Editor) et fonction en un seul fichier (Edge Functions), générés |

## Développement

Prérequis : Node 22, pnpm 10, Postgres 16 (binaires) pour les tests de base, Deno 2 pour la fonction.

```bash
pnpm install
pnpm test:coverage      # moteur : 68 tests, couverture > 90 %
pnpm typecheck
pnpm build              # PWA dans apps/web/dist
pnpm test:db            # migrations rejouées sur un Postgres jetable + 105 tests de droits (REC-10)
pnpm test:functions     # + test de bout en bout de castor-jobs et du chiffrement Web Push (Deno requis)
pnpm db:types           # régénère packages/core/src/database.ts après une migration
```

PWA en local contre une instance : créer `apps/web/.env.local` avec `VITE_SUPABASE_URL` et `VITE_SUPABASE_ANON_KEY`
(clé publishable ou anon), puis `pnpm dev`.

Prix de référence sur cours réels (REC-01) : déposer un export des cours bruts DG.PA (format Euronext ou Yahoo) dans
`packages/core/test/fixtures/dg-pa.csv` ; le test `reference.test.ts` recalcule alors les cinq prix officiels au centime.

## Mise en service

> Ne jamais coller de clé ni de mot de passe dans un chat ou un ticket : ils vont dans les réglages GitHub,
> les variables Coolify ou un `.env` local, jamais dans le dépôt.

La base et la fonction tournent soit sur **Supabase Cloud** (le plus simple, recommandé pour les essais), soit sur
un **Supabase auto-hébergé** dans Coolify. La PWA est toujours une application Coolify.

### A. Supabase Cloud

Tout se fait dans le tableau de bord Supabase, sans outil à installer ni secret à confier à GitHub : deux fichiers
du dossier `deploy/` sont à copier-coller (bouton *Copy raw file* sur GitHub), chacun à un endroit différent.

1. **Projet** : supabase.com › *New project*, région Paris (`eu-west-3`).
2. **Compte administrateur** : *Authentication › Users › Add user › Create new user*, e-mail et mot de passe,
   « Auto Confirm User » coché. Dans *Authentication › Sign In / Providers*, désactiver
   « Allow new users to sign up » (accès sur invitation).
3. **Base** : *SQL Editor › New query*, coller tout `deploy/1-base-a-coller-dans-SQL-Editor.sql`, *Run* (confirmer
   si Supabase signale des opérations destructives : elles ne visent que les restes d'une installation interrompue).
   Le résultat affiche 5 migrations et l'e-mail de l'administrateur (le seul compte du projet).
4. **Fonction** : *Edge Functions › Deploy a new function › Via Editor*, nom `castor-jobs`, remplacer le contenu
   de `index.ts` par `deploy/2-fonction-a-coller-dans-Edge-Functions.js`, *Deploy function*. Dans les réglages de la
   fonction, désactiver la vérification JWT (« Verify JWT » / « Enforce JWT verification ») : la fonction contrôle
   elle-même ses appels.
5. **Premier appel** : une fois la PWA branchée (section C), *Admin › Données de cours* › reprise de l'historique.
   Ce premier appel d'administrateur enregistre l'adresse de la fonction et active les tâches planifiées.

Le fichier SQL est relançable sans risque : il n'applique que les migrations manquantes, et supprime d'abord les
restes d'une installation interrompue. Mises à jour : recoller la dernière version du fichier SQL ; pour une fonction
modifiée, recoller le fichier `.js` (les deux sont régénérés par `node scripts/build-cloud-bundle.mjs`, la CI vérifie
qu'ils sont à jour).

Variante automatisée : le workflow `.github/workflows/supabase-cloud.yml` fait les étapes 3 à 5 à chaque push, à
condition de créer deux secrets GitHub (`SUPABASE_ACCESS_TOKEN`, `SUPABASE_DB_URL`) ; sans eux il ne fait rien.

Limite du cloud : une Edge Function dispose de 2 s de CPU par appel. Le rejeu (REC-05) réduit seul ses tirages et
espace les jours rejoués pour tenir dans ce budget ; le message de la tâche l'indique.

### B. Supabase auto-hébergé (Coolify)

1. Coolify › *New resource* › *Service* › **Supabase**.
   - Domaine du service **Kong** : `https://api.castor.<domaine>`. Retirer le domaine public de **Studio** (ou le
     protéger) : Studio ne doit pas être exposé sur Internet.
   - Si le déploiement échoue sur `minio/mc` (images MinIO retirées de Docker Hub en septembre 2026) : dans
     *Edit Compose File*, service `minio-createbucket`, remplacer l'image par celle du serveur
     `ghcr.io/coollabsio/minio:RELEASE.2025-10-15T17-29-55Z`, qui contient `mc`.
   - Variables du service d'authentification (`supabase-auth`) : inscriptions fermées
     (`GOTRUE_DISABLE_SIGNUP=true`), `GOTRUE_SITE_URL=https://castor.<domaine>`,
     `GOTRUE_URI_ALLOW_LIST=https://castor.<domaine>/**`, SMTP, et modèles d'e-mail servis par la PWA :
     `GOTRUE_MAILER_TEMPLATES_MAGIC_LINK=https://castor.<domaine>/email/magic-link.html`,
     `GOTRUE_MAILER_TEMPLATES_INVITE=https://castor.<domaine>/email/invite.html`,
     `GOTRUE_MAILER_TEMPLATES_RECOVERY=https://castor.<domaine>/email/recovery.html`.
2. Sur l'hôte Coolify :

   ```bash
   git clone https://github.com/akitto/Castor-Tracker.git /opt/castor-tracker && cd /opt/castor-tracker
   cp .env.example .env && chmod 600 .env   # renseigner les valeurs (clés du service Supabase dans Coolify)
   bash scripts/deploy-functions.sh          # copie castor-jobs dans le volume functions et redémarre le service
   bash scripts/configure-supabase.sh        # migrations, Vault, pg_cron, premier admin, reprise de l'historique
   ```

`configure-supabase.sh` est idempotent (A et B) : il ne rejoue que les migrations nouvelles (suivies dans
`castor_meta.migrations`), crée le secret des tâches planifiées dans Vault (`--rotate-secret` pour le renouveler),
(re)crée les sept tâches pg_cron et lance la reprise de l'historique si la base de cours est vide.

### C. PWA (Coolify)

Coolify › *New resource* › *Application* › *Public Repository* : `https://github.com/akitto/Castor-Tracker`,
branche `main`.

- build pack **Dockerfile**, répertoire de base `/`, Dockerfile `/apps/web/Dockerfile` ;
- **Ports Exposes : `80`** (Nginx), healthcheck `/healthz` ;
- domaine `https://castor.<domaine>` (ou *Generate Domain* pour une adresse de test) ;
- variables : `SUPABASE_URL` (`https://<ref>.supabase.co`, ou `https://api.castor.<domaine>` en auto-hébergé) et
  `SUPABASE_PUBLISHABLE_KEY` (ou `SUPABASE_ANON_KEY`, clé anon d'une instance auto-hébergée). Elles sont écrites
  dans `/config.js` au démarrage : changer de clé ne demande qu'un redémarrage. Sans elles, la PWA affiche
  « Configuration absente ».

Redéploiement à chaque push : ajouter dans GitHub le webhook fourni par Coolify (onglet *Webhooks* de
l'application), ou passer par l'app GitHub de Coolify.

### D. Premier lancement (lot 0)

1. Se connecter avec le compte administrateur, configurer le TOTP (obligatoire pour l'administration).
2. *Admin › Données de cours* : vérifier la reprise de l'historique (≈ 3 000 séances depuis 2015) et le contrôle Euronext.
3. *Admin › Quadrimestres* : importer les prix officiels 2018–2025 (CSV `code;date_ca;prix;avis`).
4. *Admin › Backtest* : lancer le backtest (REC-01 : la variante « ouverture, centime au plus proche, jour du CA
   exclu » doit retrouver tous les prix au centime), l'inférence des dates manquantes, puis le rejeu (REC-05).
5. *Admin › Accès* : inviter les lecteurs (e-mail ou lien à transmettre), choisir la visibilité (restreinte par défaut).

### E. Sauvegardes (ENF-07)

Supabase Cloud sauvegarde la base chaque jour (selon l'offre). En auto-hébergé, `scripts/backup.sh` (cron quotidien
sur l'hôte) : dump des schémas `public`, `auth` et `castor_meta` vers `BACKUP_DIR` (NAS), 30 jours de rétention.
Restauration à tester sur une instance de test (REC-11).

### F. Intégration continue

- `.github/workflows/ci.yml` : tests du moteur, typage, build, migrations + tests de droits + test de bout en bout.
- `.github/workflows/supabase-cloud.yml` : déploiement automatisé sur Supabase Cloud (variante de la section A).
- La CI vérifie aussi que `deploy/` correspond au code (`node scripts/build-cloud-bundle.mjs`).
- `.github/workflows/deploy.yml` : migrations et déploiement de la fonction sur un runner auto-hébergé du homelab
  (section B ; activer avec la variable de dépôt `CASTOR_DEPLOY_ENABLED=true`).

## Exploitation

### Tâches planifiées (heure de Paris, jours de séance)

| Heure | Tâche | Effet |
| --- | --- | --- |
| 9 h 20 (relance 9 h 40) | `open` | Ouverture du jour, nouvelle estimation |
| toutes les 15 min, 9 h – 17 h 50 | `quote` | Cours en séance (différé 15 min), non journalisé |
| 18 h (relances 18 h 30, 21 h) | `session` | Séance complète, contrôle Euronext, estimation, prix recalculés |
| 7 h 30, tous les jours | `catchup` | Rattrapage des 30 derniers jours, estimation |
| 1er du mois | `maintenance` | Fermetures Euronext de l'année suivante, quadrimestres suivants, purge du journal et des notifications (120 jours) |
| toutes les 15 min | `notify` | Notifications différées (heures calmes) et relances ; battement du moniteur externe. Non journalisé |

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
| Secret des tâches compromis | Cloud : workflow « Supabase Cloud », case « Renouveler le secret » ; auto-hébergé : `bash scripts/configure-supabase.sh --rotate-secret` |

### Notifications

Web Push pour tous les comptes, webhook en plus pour les administrateurs. Chaque compte règle les siennes dans
*Mon compte › Notifications* : un interrupteur général, un interrupteur par notification (avec ses seuils), les heures
calmes (21 h – 8 h, envoi reporté à 8 h sauf urgences admin) et la liste de ses appareils.

| Notification | Public | Déclencheur |
| --- | --- | --- |
| Variation de l'estimation | tous | `session` (18 h) : écart ≥ seuil personnel (0,50 € par défaut) depuis la dernière alerte |
| Fenêtre de calcul | tous | Toute estimation : passage en « fenêtre », puis prix figé |
| Date du CA connue | tous | Trigger SQL : date saisie au statut « connue » (quadrimestre en cours ou à venir) |
| Clôture des versements | tous | `catchup` (7 h 30) : J−3 et dernier jour |
| Prix officiel annoncé | tous | Trigger SQL : prix saisi (écart avec l'estimation finale, plus-value au cours actuel) |
| Alerte de cours | tous (désactivée par défaut) | `quote` et `session` : seuils haut et bas personnels, réarmés à 0,5 % |
| Résumé hebdomadaire | tous (désactivé par défaut) | `catchup` du lundi |
| Tâche en échec (urgent) | admins | Trigger SQL : deux échecs consécutifs d'une tâche |
| Séance non collectée (urgent) | admins | `catchup` : pas de `session` réussie pour la dernière séance |
| Anomalie de données | admins | Écart Yahoo/Euronext, repli sur Euronext, séances manquantes, ouverture à plus de 8 % sans dividende |
| Saisie à faire | admins | Date du CA inconnue à J−7 du créneau ; prix officiel non saisi 3 jours après le CA et la clôture |
| Écart au centime | admins | Prix officiel ≠ prix recalculé alors que les 20 séances sont connues |
| Inférence ambiguë | admins | `infer` : plusieurs dates possibles |
| Sécurité et accès (urgent) | admins | Rôle accordé, modifié, retiré ; secret des tâches renouvelé |

Fonctionnement : un événement par fait (`notification_events`, clé de déduplication), réparti en envois par compte et
par canal (`notification_deliveries`) selon les préférences, puis envoyé par `castor-jobs` à la fin de chaque tâche,
sur appel pg_net quand un trigger SQL crée l'événement, et toutes les 15 min. Trois essais (15 puis 30 min d'écart),
abonnements expirés supprimés, envois de plus de 36 h abandonnés. Chiffrement Web Push (RFC 8291) et VAPID
(RFC 8292) écrits avec WebCrypto, sans dépendance.

Mise en service :

1. Supabase Cloud : recoller `deploy/1-base-a-coller-dans-SQL-Editor.sql` (SQL Editor) puis
   `deploy/2-fonction-a-coller-dans-Edge-Functions.js` (fonction `castor-jobs`). Auto-hébergé :
   `bash scripts/deploy-functions.sh` puis `bash scripts/configure-supabase.sh`. La migration ajoute d'elle-même la
   tâche `castor-notify` si les tâches planifiées existent déjà.
2. Rien à générer : la paire de clés VAPID est créée au premier abonnement (privée dans Vault sous
   `castor_vapid_private`, publique dans `app_config.vapid_public_key`). `app_config.site_url` sert d'identifiant VAPID
   et d'adresse des liens des webhooks : posé par `SITE_URL` en auto-hébergé, sinon repris de l'adresse HTTPS de la
   PWA au premier abonnement.
3. Chaque appareil s'abonne depuis *Mon compte › Notifications*. Sur iPhone et iPad (iOS 16.4 et plus), la PWA doit
   d'abord être installée sur l'écran d'accueil et ouverte depuis son icône.
4. Webhook (admins, session TOTP) : JSON générique (Home Assistant, n8n), ntfy (URL du sujet), Discord, Slack et
   compatibles ; en-tête `Authorization` facultatif, bouton de test.
5. *Admin › Notifications* : journal des envois et URL du **moniteur externe** (Uptime Kuma « Push » ou healthchecks.io),
   appelée à chaque passage planifié. C'est la seule alerte possible si pg_cron ou la fonction s'arrêtent.

Ne jamais régénérer la clé VAPID à la main : tous les abonnements existants deviendraient invalides.

### Diagnostic

- Journal des tâches : *Admin › Journal des tâches* (table `job_runs`), audit des écritures admin (`audit_log`).
- Notifications : *Admin › Notifications* (vue `v_notification_log`), envois en attente :
  `select * from notification_deliveries where status in ('pending', 'sending');`
- Appels pg_net : `select * from net._http_response order by created desc limit 20;`
- Exécutions pg_cron : `select * from cron.job_run_details order by start_time desc limit 20;`
- Fonction : *Edge Functions › castor-jobs › Logs* (cloud) ou `docker logs <conteneur supabase-edge-functions>` ;
  santé : `GET /functions/v1/castor-jobs`.

## Sécurité

- RLS sur toutes les tables ; lecture selon la visibilité (publique, restreinte, privée) ; écriture réservée aux
  administrateurs, dont la session doit être validée par TOTP (`aal2`), contrôlé en base (`is_admin()`) et dans la fonction.
- La clé secrète (ou `service_role`) reste dans le service des fonctions et les secrets GitHub ; seule la clé publique
  (publishable ou `anon`) est livrée au navigateur.
- Le secret des tâches planifiées est dans Vault et vérifié en base ; il n'apparaît dans aucun fichier du dépôt.
- Pages non indexées (`robots.txt`, `X-Robots-Tag`, meta), CSP stricte, aucun traceur tiers.

## Écarts avec le cahier des charges

- Les tables vivent dans le schéma `public` de l'instance dédiée (au lieu d'un schéma `castor`) : PostgREST les
  expose sans modifier la configuration du modèle Coolify.
- Table supplémentaire `app_config` : visibilité, TOTP obligatoire, adresse du site, seuil d'alerte, URL Euronext.
- Les tâches lancées depuis le back-office appellent directement la fonction (pas de table de requêtes).
- Alertes visibles dans le back-office, et notifications Web Push et webhook (section « Notifications »).

## Limites connues

- Yahoo Finance et Euronext Live sont des points d'accès non contractuels : le contrôle croisé, le repli et l'import
  CSV couvrent leurs défaillances ; le backtest au centime valide la source au lot 0.
- L'inférence d'une date de CA peut être ambiguë (deux dates donnant le même prix au centime) : elle n'est alors pas
  appliquée et toutes les dates sont listées.
- Estimation non officielle, pas un conseil en investissement.
