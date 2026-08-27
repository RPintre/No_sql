# Jour 4 - Sharding appliqué, Performances & Diagnostic

## Partie A - Sharding appliqué (census.zips)

**Q1.**

- `cfg1` : serveur de configuration (config server). C'est lui qui stocke la carte de routage - la table qui
  associe chaque intervalle de valeurs de la shard key à un shard donné (`config.chunks`, `config.collections`).
- `shardA` et `shardB` : les deux shards, chacun un replica set à un seul membre ici. Ce sont les deux seuls
  conteneurs qui hébergent réellement des données applicatives.
- `mongos` : le routeur. Il n'héberge **aucune donnée** lui-même - il consulte `cfg1` pour savoir vers quel(s)
  shard(s) envoyer chaque requête, puis fusionne les réponses si nécessaire. C'est le seul point d'entrée que
  les clients (mongosh, pymongo...) doivent utiliser.

Réduire la taille des chunks de 128 Mo à 1 Mo est **indispensable dans ce TP** parce que le jeu de données
(`census.zips`, environ 3 Mo) ne dépasserait jamais un seul chunk de 128 Mo : sans ce réglage, aucun split ni
aucune migration ne se produirait jamais, et toute la partie A (mesurer un déséquilibre, forcer des
migrations, observer des orphelins) serait invisible.

Ce serait une **très mauvaise idée en production** pour la raison inverse : sur un vrai volume de données
(plusieurs centaines de Go ou plus), des chunks de 1 Mo produiraient des centaines de milliers, voire des
millions de chunks. Chaque chunk est une ligne de métadonnées dans `config.chunks` que le config server doit
gérer, et chaque déséquilibre déclenche une migration - avec autant de petits chunks, le balancer passerait
son temps à migrer en continu de minuscules volumes de données, saturant le réseau et le disque pour un gain
quasi nul, sans compter la charge supplémentaire sur le config server lui-même.

**Q2 à Q9.** Voir [bench_shard.md](bench_shard.md) pour le détail complet (sorties d'`getShardDistribution()`,
frontières de chunks, les 3 `explain()` targeted/broadcast et le tableau de décision). Résumé :

- **Q2** : 2 chunks, shardA 68,68 % des données / 76,12 % des documents comptés, shardB 31,31 % / 23,87 % -
  pas équilibré.
- **Q3** : coupure sur `KY`, pas le milieu de l'alphabet ; le balancer équilibre le nombre de chunks, pas
  l'ordre alphabétique.
- **Q4** : 6 chunks après les 4 `splitAt` forcés (shardA : 4, shardB : 2), mais **0 point de mouvement** dans
  la répartition par documents - `splitAt` ne déplace aucune donnée, et aucune migration n'a suivi (confirmé
  par `config.changelog`). Le Texas, l'État le plus peuplé (1676 zips), ne pèse qu'environ 186 Ko - loin des
  1 Mo d'un chunk ; le vrai blocage est que le balancer n'agit qu'à partir d'un écart de 2 chunks entre shards
  (pour une collection de moins de 20 chunks), et shardA/shardB sont exactement à cet écart, pas au-delà.
- **Q5** : `countDocuments()` = 29470, `estimatedDocumentCount()` = 38712, écart de 9242 - exactement le
  nombre de documents de l'unique migration passée. Ce sont des **documents orphelins**. Prédiction formulée
  à partir de `orphanCleanupDelaySecs` (900 s par défaut) : l'écart doit disparaître 15 minutes plus tard
  (vérification prévue en fin de séance, cluster laissé allumé).
- **Q6/Q7** : `{state:"NY"}` est targeted (`SINGLE_SHARD`, un seul shard interrogé, 1596 examinés pour 1596
  retournés) ; `{city:"NEW YORK"}` est broadcast (`SHARD_MERGE`, les deux shards interrogés, 38712 examinés
  pour seulement 40 retournés, ratio 967,8). Extrapolé à 20 shards / 500 M documents, une requête broadcast
  lirait la totalité des 500 millions de documents sur les 20 machines, quel que soit le nombre de shards.
- **Q8** : clé hachée `{ _id: "hashed" }` -> distribution quasi parfaite (49,26 % / 50,73 %) dès le départ,
  grâce au pre-splitting sur une collection vide ; aucun écart de comptage ici, car aucune migration n'a
  jamais eu lieu.
- **Q9** : la même requête `{state:"NY"}` devient broadcast (`SHARD_MERGE`) sur la collection hachée. Le
  compromis : une clé hachée distribue parfaitement l'écriture mais sacrifie tout ciblage de requête sur les
  autres champs. Tableau de décision complet dans `bench_shard.md`.
