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

## Partie B - Performances & diagnostic (citibike.trips)

**Point de contrôle B0.**

```js
db.trips.countDocuments({})   // 10000
db.trips.findOne()
```

Le document affiché confirme des noms de champs contenant des espaces : `start station id`,
`start station name`, `end station id`, `end station name`, `birth year`.

Le cluster shardé de la Partie A a été laissé allumé pendant tout ce travail. Sa vérification finale (Q5(d))
est consignée dans `bench_shard.md` : l'écart de comptage a bien disparu après 15 minutes.

**Q10.** Les espaces dans un nom de champ empêchent la notation pointée habituelle (`db.trips.find({start
station id: 476})` est un JSON invalide, erreur de syntaxe immédiate). Il faut systématiquement encadrer le
nom de champ entre guillemets :

- (a) filtre `find` : `db.trips.find({ "start station id": 476 })`
- (b) référence dans un `$group` : `{ $group: { _id: "$start station id", ... } }` (le `$` devant une chaîne
  entre guillemets reste obligatoire pour désigner un champ dans une expression d'agrégation)

Si on oublie les guillemets, MongoDB (ou le shell JS) interprète `station` et `id` comme des tokens séparés -
résultat : une erreur de syntaxe à l'analyse (`SyntaxError: Unexpected identifier`), la requête n'est même
pas envoyée au serveur.

**Q11.**

```js
db.trips.aggregate([{ $group: { _id: null, debut: { $min: "$start time" }, fin: { $max: "$stop time" } } }])
```

- `$min` de `start time` : `2016-01-01T00:00:41.000Z`
- `$max` de `stop time` : `2016-01-02T19:35:22.000Z`

Le jeu s'annonce comme "1er et 2 janvier 2016", ce qui correspond bien à ce qu'on observe : le premier trajet
commence à 00:00:41 le 1er janvier, et le dernier se termine à 19:35 le 2 janvier - moins de deux jours
pleins de données, pas un mois entier malgré la mention "janvier 2016" du contexte métier.

**Q12.** Top 5 des stations de départ :

| Station | Trajets |
|---|---|
| Central Park S & 6 Ave | 114 |
| Lafayette St & E 8 St | 99 |
| Carmine St & 6 Ave | 95 |
| Broadway & E 14 St | 93 |
| E 17 St & Broadway | 86 |

**Q13.** Répartition par `usertype` :

| usertype | trajets | durée moyenne |
|---|---|---|
| Subscriber | 8011 | 762,36 s |
| Customer | 1989 | 2610,71 s |

Le rapport est de 2610,71 / 762,36 ≈ **3,42** : un trajet Customer dure en moyenne 3,4 fois plus
longtemps qu'un trajet Subscriber. Hypothèse métier : les Subscriber sont des abonnés réguliers qui
utilisent le vélo pour un trajet utilitaire court (domicile-travail, correspondance), tandis que les Customer
sont des utilisateurs occasionnels (touristes, achat au ticket) qui gardent le vélo plus longtemps, pour une
balade plutôt qu'un trajet point-à-point.

**Q14.**

```js
db.trips.aggregate([
  { $group: { _id: { $dateTrunc: { date: "$start time", unit: "day" } }, n: { $sum: 1 } } },
  { $sort: { _id: 1 } }
])
```

| Jour | Trajets |
|---|---|
| 2016-01-01 | 6348 |
| 2016-01-02 | 3652 |

**2 jours**, ce qui est parfaitement cohérent avec la plage observée en Q11 (du 1er janvier 00h00 au 2 janvier
19h35).

**Q15.** Top 5 des heures de départ :

| Heure | Trajets |
|---|---|
| 13h | 1061 |
| 12h | 827 |
| 11h | 778 |
| 15h | 709 |
| 14h | 685 |

Ce profil (pic entre 11h et 15h, creux implicite tôt le matin et en soirée) ne ressemble **pas** à un usage
domicile-travail classique, qui montrerait deux pics nets vers 8h et 17-18h. C'est cohérent avec la date :
le 1er janvier 2016 était un **vendredi**, jour férié (jour de l'an) - l'essentiel du trafic du jeu (6348 sur
10000 trajets) vient de ce jour-là, ce qui explique un usage plutôt loisir/tourisme en milieu de journée que
domicile-travail.

**Q16.**

```js
db.trips.aggregate([{ $bucket: { groupBy: "$tripduration", boundaries: [0, 300, 600, 1800, 3600, 1000000], output: { n: { $sum: 1 } } } }])
```

| Tranche (s) | Effectif |
|---|---|
| [0, 300) | 2009 |
| [300, 600) | 3136 |
| [600, 1800) | 3953 |
| [1800, 3600) | 652 |
| [3600, 1000000) | 250 |

La tranche la plus peuplée est **[600, 1800)** (10 à 30 minutes), avec 3953 trajets.

**Q17.**

```js
db.trips.countDocuments({ $expr: { $eq: ["$start station id", "$end station id"] } })
```

**316** trajets repartent de la station où ils sont arrivés (boucles). Comparer deux champs du même document
impose bien `$expr` : un filtre `find` classique (`{ "start station id": "$end station id" }`) comparerait le
champ à la chaîne littérale `"$end station id"`, pas au champ correspondant.

## Partie B2 - Qualité de données et optimiseur

**Q18.**

```js
db.trips.countDocuments({ "birth year": { $type: "string" } })   // 1989
db.trips.countDocuments({ "birth year": { $type: "int" } })      // 8011
```

Croisé avec `usertype` :

| type de birth year | usertype | n |
|---|---|---|
| int | Subscriber | 8011 |
| string | Customer | 1989 |

La correspondance est exacte et totale : **tous** les Subscriber (8011, le même effectif qu'en Q13) ont un
`birth year` numérique, et **tous** les Customer (1989, même effectif qu'en Q13) l'ont stocké en chaîne de
caractères. C'est exactement le piège annoncé en tête du TP : un champ numérique stocké en chaîne sur une
partie exacte de la population (ici, la totalité des Customer).

Conséquence concrète : une requête `{ "birth year": { $lt: 1950 } }` est **silencieusement fausse**, car un
comparateur numérique (`$lt`) appliqué à un champ de type chaîne ne matche jamais ce champ en BSON (les
comparaisons `$lt`/`$gt` respectent l'ordre des types BSON, et `string` n'est pas comparé à `number`) - la
requête ne renverra jamais aucun Customer, sans la moindre erreur pour le signaler. Un rapport construit sur
cette requête exclurait purement et simplement 1989 usagers (presque 20 % du jeu) sans que personne ne s'en
rende compte.

**Q19.**

```js
db.trips.aggregate([
  { $match: { "birth year": { $type: "number" } } },
  { $group: { _id: null, ageMoyen: { $avg: { $subtract: [2016, "$birth year"] } }, n: { $sum: 1 }, naissanceMin: { $min: "$birth year" } } }
])
```

- Âge moyen : **39,86 ans**
- Effectif retenu : **8011** (uniquement les Subscriber, seuls à avoir un `birth year` numérique - voir Q18)
- Naissance la plus ancienne : **1885**, soit un âge de 131 ans en 2016.

Cette dernière valeur n'est **pas crédible**. En production, ce document mérite d'être signalé et traité à
part (exclu du calcul d'âge, ou vérifié manuellement) - une valeur par défaut ou une erreur de saisie
(1985 tapé 1885, ou une valeur sentinelle mal choisie) est bien plus probable qu'un usager centenaire à vélo.

**Q20.**

```js
db.trips.countDocuments({ tripduration: { $gt: 10800 } })   // > 3h : 54
db.trips.countDocuments({ tripduration: { $gt: 86400 } })   // > 24h : 9
```

3 trajets les plus longs :

| tripduration (s) | usertype |
|---|---|
| 326222 (~90,6 h) | Subscriber |
| 279620 (~77,7 h) | Customer |
| 173357 (~48,2 h) | Customer |

Explication métier probable : un vélo non redocké correctement (rendu dans une station mais le loquet mal
verrouillé, ou volé puis retrouvé/redéposé plus tard) - le système continue de compter la durée jusqu'au
retour effectif détecté, produisant des trajets de plusieurs jours qui ne reflètent aucun usage réel.

**Q21.**

```js
db.trips.aggregate([
  { $match: { tripduration: { $lte: 10800 } } },
  { $group: { _id: "$usertype", n: { $sum: 1 }, dureeMoyenne: { $avg: "$tripduration" } } }
])
```

### (a) Nouvelles moyennes

| usertype | n (après exclusion) | durée moyenne |
|---|---|---|
| Subscriber | 7998 | 648,59 s |
| Customer | 1948 | 1717,93 s |

### (b) Écart avec la Q13

| usertype | Q13 (brut) | Q21 (filtré) | écart |
|---|---|---|---|
| Subscriber | 762,36 s | 648,59 s | -14,9 % |
| Customer | 2610,71 s | 1717,93 s | -34,2 % |

Les deux populations ne sont **pas** affectées de la même façon : la moyenne Customer chute plus du double
(en pourcentage) de celle des Subscriber. C'est cohérent avec la répartition des exclusions ci-dessous : les
trajets aberrants touchent bien plus les Customer, en proportion, que les Subscriber.

### (c) Trajets exclus

54 trajets exclus au total (0,54 % du jeu de 10000), répartis ainsi :

| usertype | trajets exclus |
|---|---|
| Customer | 41 |
| Subscriber | 13 |

41 exclusions sur 1989 Customer (2,06 %) contre 13 sur 8011 Subscriber (0,16 %) : les valeurs aberrantes sont
environ 13 fois plus fréquentes chez les Customer, proportionnellement - ce qui explique directement pourquoi
leur moyenne bouge tellement plus en (b) : une poignée de trajets de plusieurs dizaines d'heures pèse
beaucoup plus lourd sur une moyenne quand la population de base est petite (1989) que quand elle est grande
(8011).

### (d) Quelle valeur communiquer

La valeur **filtrée (Q21)** est la plus honnête à communiquer à la direction : la valeur brute (Q13) est
tirée vers le haut par une poignée de trajets clairement anormaux (vélos non redockés plusieurs jours), qui
ne représentent aucun usage réel du service. À condition de le documenter explicitement (voir R3).

**Q22.** Deux pipelines qui renvoient le même résultat :

```js
// A
[ { $match: { usertype: "Subscriber" } }, { $group: { _id: "$start station id", n: { $sum: 1 } } } ]
// B
[ { $group: { _id: { s: "$start station id", u: "$usertype" }, n: { $sum: 1 } } }, { $match: { "_id.u": "Subscriber" } } ]
```

`db.trips.explain("executionStats").aggregate([...])` sur les deux :

| | Pipeline A | Pipeline B |
|---|---|---|
| totalDocsExamined (étage `$cursor`) | 10000 | 10000 |
| nReturned du `$cursor` | 8011 | 8011 |
| nReturned final (`$group`) | 459 | 459 |

**Les deux plans sont identiques.** C'est le résultat intéressant de cette question : bien que `$match` soit
écrit *après* `$group` dans le pipeline B, l'explain montre que MongoDB a quand même réussi à remonter le
filtre `{ "_id.u": "Subscriber" }` jusque dans le `$cursor` initial (`parsedQuery: { usertype: { $eq:
"Subscriber" } }`), exactement comme pour le pipeline A. L'optimiseur (« aggregation pipeline optimization »)
sait reconnaître qu'ici `_id.u` n'est qu'un **simple alias** direct du champ source `$usertype` (pas une
valeur calculée), et il retrace cette filiation à travers le `$group` pour réécrire le filtre en amont, avant
même que les documents n'entrent dans le pipeline. Concrètement : écrire le `$match` en premier n'a fait ici
aucune différence mesurable, car l'optimiseur l'aurait remonté de toute façon.

**Q23.**

```js
[ { $group: { _id: "$start station id", n: { $sum: 1 } } }, { $match: { n: { $gt: 50 } } } ]
```

Ici, **10000 documents** traversent le `$group` (contre 8011 dans le `$cursor` de la Q22) : l'optimiseur ne
peut absolument rien pousser en amont. La raison est structurelle et non une limite d'implémentation : `n`
n'existe pas avant que `$group` ait fini son travail - c'est le résultat d'un accumulateur (`$sum`) calculé
en agrégeant tous les documents d'un groupe, donc sa valeur ne peut logiquement être connue qu'après le
`$group` complet. Contrairement à la Q22 où `_id.u` était un alias direct et retraçable jusqu'à un champ
source, `n` est une valeur dérivée : il n'y a rien à retracer.

**34 stations** dépassent 50 départs.

**Règle générale** : l'optimiseur ne peut remonter un `$match` avant un `$group` que s'il porte sur un champ
qui est un **alias direct** d'un champ d'entrée (via `_id` ou un champ passé tel quel) ; il ne peut jamais le
faire si le `$match` porte sur le résultat d'un accumulateur (`$sum`, `$avg`, `$count`, etc.), car cette
valeur n'existe qu'après l'agrégation complète des documents du groupe.

## Partie B3 - Matérialisation et jointure

**Q24.**

```js
db.trips.aggregate([
  { $group: { _id: "$start station id", nom: { $first: "$start station name" }, position: { $first: "$start station location" }, departs: { $sum: 1 } } },
  { $merge: { into: "stations", whenMatched: "replace" } }
])
```

**462 stations.** Les 3 premières par nombre de départs :

| Station | Départs |
|---|---|
| Central Park S & 6 Ave | 114 |
| Lafayette St & E 8 St | 99 |
| Carmine St & 6 Ave | 95 |

(sans surprise, identique au top des départs de la Q12 : `stations` est directement dérivée de `trips`).

**Q25.** `$out` remplace **intégralement** la collection cible à chaque exécution (elle est effacée puis
recréée) ; `$merge` peut fusionner de façon incrémentale, document par document, selon une clé de
correspondance (`whenMatched`, `whenNotMatched`). Pour un rafraîchissement quotidien du tableau de bord, c'est
**`$merge`** qu'il faut utiliser : il permet de ne recalculer et remplacer que les documents concernés (par
exemple, ne traiter que les stations actives dans les nouveaux trajets du jour), sans avoir à reconstruire
toute la collection à chaque fois, et sans laisser la collection vide le temps du recalcul comme le ferait
`$out`.

**Q26.**

```js
db.trips.aggregate([
  { $group: { _id: "$end station id", n: { $sum: 1 } } },
  { $sort: { n: -1 } }, { $limit: 5 },
  { $lookup: { from: "stations", localField: "_id", foreignField: "_id", as: "info" } },
  { $unwind: "$info" },
  { $project: { _id: 1, nom: "$info.nom", n: 1 } }
])
```

| Station (arrivée) | Arrivées |
|---|---|
| E 17 St & Broadway | 96 |
| Central Park S & 6 Ave | 95 |
| Broadway & E 14 St | 91 |
| W 21 St & 6 Ave | 85 |
| West St & Chambers St | 85 |

Comparaison avec le top des départs (Q12) : **Central Park S & 6 Ave**, **Broadway & E 14 St** et
**E 17 St & Broadway** apparaissent dans les deux classements - ce sont des stations à fort trafic dans les
deux sens. En revanche **West St & Chambers St** et **W 21 St & 6 Ave** ne figurent que dans le top des
arrivées : une station qui reçoit nettement plus de vélos qu'elle n'en émet peut signaler un point d'intérêt
en fin de trajet (bureaux, correspondance vers un autre mode de transport, zone touristique) qui accumule des
vélos au cours de la journée - une station à surveiller pour le rééquilibrage manuel du parc.

## Partie B4 - Index géospatial 2dsphere

Voir [geo.js](geo.js) pour le détail complet des commandes.

**Q27.** Sans index, `$near` échoue :

```
ERREUR : error processing query: ns=citibike.tripsTree: GEONEAR field=start station location maxdist=500
isNearSphere=0 ... planner returned error :: caused by :: unable to find index for $geoNear query
```

Un index géospatial est **obligatoire** (et non simplement conseillé comme pour une requête classique) parce
que `$near` ne fait pas qu'un filtre : c'est intrinsèquement une opération de **tri par distance**, et
MongoDB n'a aucun moyen de calculer efficacement une distance entre points GeoJSON et de trier par cette
distance sans une structure d'index spécialisée (2dsphere) qui organise déjà l'espace géographique - sans
elle, il n'existe tout simplement aucun plan d'exécution possible.

**Q28.**

```js
db.trips.createIndex({ "start station location": "2dsphere" })
```

**148 résultats.** Les premiers documents renvoyés viennent tous de la même station la plus proche
("W 45 St & 6 Ave"), puis de la seconde ("W 45 St & 8 Ave") : `$near` trie les **documents individuels** par
distance croissante de leur point de départ au point de référence, pas les stations - une station très
fréquentée et proche remonte donc en bloc avant une station plus éloignée, même moins fréquentée.

**Q29.**

```
ERREUR : $geoNear, $near, and $nearSphere are not allowed in this context, as these operators require
sorting geospatial data. If you do not need sort, consider using $geoWithin instead.
```

`countDocuments()` est en réalité une agrégation déguisée (elle s'exécute via un pipeline `$match` +
`$count` en interne) - or `$near` n'a de sens que dans un contexte qui produit un curseur trié, ce qu'une
agrégation de comptage ne fait pas. Le message d'erreur suggère lui-même la solution : `$geoWithin`, qui ne
trie pas, filtre juste par appartenance à une zone.

```js
var rad500 = 0.5 / 6378.1;
var rad1000 = 1 / 6378.1;
db.trips.countDocuments({ "start station location": { $geoWithin: { $centerSphere: [[-73.9855, 40.7580], rad500] } } })
db.trips.countDocuments({ "start station location": { $geoWithin: { $centerSphere: [[-73.9855, 40.7580], rad1000] } } })
```

- Moins de 500 m : **148** trajets
- Moins de 1000 m : **774** trajets

**Q30.**

```js
db.stations.createIndex({ position: "2dsphere" })
db.stations.aggregate([
  { $geoNear: { near: { type: "Point", coordinates: [-73.9855, 40.7580] }, distanceField: "distanceM", maxDistance: 1000, spherical: true } },
  { $project: { _id: 1, nom: 1, distanceM: { $round: ["$distanceM", 0] }, departs: 1 } },
  { $sort: { distanceM: 1 } }
])
```

**34 stations** à moins d'1 km de Times Square. La plus proche : **W 45 St & 6 Ave**, à **256 m**.

`$geoNear` doit obligatoirement être le **premier** stage du pipeline parce que, comme `$near`, c'est une
opération qui a besoin de consulter directement l'index géospatial de la collection source pour calculer et
trier par distance - une fois que d'autres stages ont déjà transformé ou filtré les documents (donc quitté le
contexte de la collection indexée), il n'y a plus d'index à consulter pour faire ce calcul.

## Partie B5 - Diagnostic

Voir [diagnostic.md](diagnostic.md) pour le détail complet (tableaux avant/après, extraits de
`system.profile`).

**Q31.** Avant index sur `start station id` : `COLLSCAN`, 10000 documents examinés pour 36 retournés (ratio
277,8). Après création de l'index `{ "start station id": 1 }` : `FETCH` + `IXSCAN`, 36 clés et 36 documents
examinés pour 36 retournés (ratio **1,0**). Le ratio idéal est 1 ; on ne l'atteint pas toujours même avec un
bon index dès qu'une requête combine plusieurs critères ou porte sur une plage plutôt qu'une égalité stricte
- il faut alors un index composite (voire une projection couvrante) pour éviter tout `FETCH` superflu.

**Q32.** Profiler activé en niveau 1 (`slowms: 0`) sur un `find` non indexé (`end station name`) et une
agrégation (`$group` sur `usertype`) : **2 entrées** dans `system.profile`, toutes deux en `planSummary:
COLLSCAN` (5 ms et 10 ms) - confirmation, via l'activité réelle plutôt qu'un `explain` manuel, que ces deux
accès ne sont pas optimisés.

**Q33.** Niveaux 0 (désactivé), 1 (seuil `slowms`), 2 (tout enregistrer). En production : niveau 1 avec
`slowms` autour de 100-200 ms. Deux risques du niveau 2 : surcharge d'écriture sur chaque opération, et
`db.system.profile.stats().capped` vaut **`true`** - la collection est plafonnée (1 Mo par défaut), donc au
niveau 2 sur une base chargée les entrées les plus anciennes sont écrasées en quelques secondes, perdant
potentiellement l'opération lente qui a déclenché l'investigation.

**Q34.**

```js
db.system.profile.find({ planSummary: "COLLSCAN", millis: { $gt: N } })
```

isole exactement les opérations qui méritent une indexation prioritaire : lentes **et** en parcours complet.

## Partie C - Réflexion

**R1. Le tableau de bord quotidien.**

Plutôt que de recalculer les agrégations de la Partie B1 à chaque affichage du tableau de bord, on
matérialise le résultat dans une collection dérivée via `$merge` (comme `stations` en Q24), rafraîchie chaque
matin à 6h par un job planifié (cron, tâche planifiée MongoDB Atlas, ou simple script appelé par un
ordonnanceur). Le tableau de bord interroge ensuite uniquement cette petite collection, indexée sur les
champs consultés, avec le profiler actif en continu (niveau 1, `slowms` bas) pour détecter toute dérive de
performance.

Chiffrage du gain : la Q23 (agrégation complète sur `trips` sans filtre poussé) fait passer **10000**
documents dans le `$group`. La collection `stations` dérivée (Q24) ne compte que **462** documents. Rapport :
10000 / 462 ≈ **21,6** - chaque lecture du tableau de bord coûte environ 21,6 fois moins de documents
parcourus que de recalculer depuis `trips`. Le compromis accepté : la donnée affichée n'est fraîche qu'à la
dernière exécution du job de rafraîchissement (potentiellement jusqu'à 24h de retard dans le pire cas), ce
qui est explicitement acceptable ici puisque la direction ne demande qu'un rafraîchissement quotidien, pas
temps réel.

**R2. La règle d'écriture des pipelines, vérifiée.**

Règle en trois phrases, à partir des Q22 et Q23 : L'optimiseur d'agrégation peut remonter un `$match` avant
un `$group` (voire jusque dans le curseur initial) quand ce `$match` porte sur un champ qui reste un simple
alias traçable d'un champ d'entrée, même à travers un `_id` composé. Il ne peut jamais le faire quand le
`$match` porte sur une valeur produite par un accumulateur (`$sum`, `$avg`...), puisque cette valeur n'existe
qu'après l'agrégation complète du groupe. Écrire `$match` en premier reste malgré tout la bonne habitude à
prendre : dans le meilleur des cas l'optimiseur l'aurait fait à votre place, mais dans le pire cas (Q23) c'est
la seule façon d'obtenir un filtrage précoce.

Test complémentaire : un troisième pipeline avec un `$project` qui supprime le champ, suivi d'un `$match` sur
ce même champ :

```js
db.trips.explain("executionStats").aggregate([{ $project: { usertype: 0 } }, { $match: { usertype: "Subscriber" } }])
```

L'explain montre deux stages seulement : `$cursor` (qui absorbe le `$project`) puis `$match` - **le `$match`
n'est pas remonté** cette fois, et le pipeline renvoie **0 résultat**. Ce troisième cas montre la frontière
exacte de ce que sait faire l'optimiseur : il sait suivre un champ à travers un renommage ou un regroupement
tant que ce champ existe toujours quelque part dans le document sous une forme traçable, mais dès qu'un
`$project` supprime purement et simplement le champ, toute référence ultérieure à ce champ ne peut plus être
retracée jusqu'à la source - le `$match` s'exécute bien, mais contre un champ qui n'existe plus (donc
`undefined`), ce qui ne produit pas une erreur mais un résultat vide et silencieux. C'est un piège plus
sournois qu'un simple défaut de performance.

**R3. Le chiffre unique, et son coût.**

(a) Phrase pour le rapport : *"La durée moyenne d'un trajet Citi Bike est de 649 secondes pour les abonnés
(Subscriber, n = 7998) et de 1718 secondes pour les usagers occasionnels (Customer, n = 1948), les trajets de
plus de 3 heures (54 sur 10000, soit 0,54 % du jeu) ayant été exclus car ils correspondent à des vélos non
redockés plutôt qu'à un usage réel."*

(b) Médiane sur le jeu **non filtré** (`$median`, méthode approximée) :

```js
db.trips.aggregate([{ $group: { _id: null, mediane: { $median: { input: "$tripduration", method: "approximate" } } } }])
```

Médiane : **578,78 s**. Comparaison avec les moyennes globales (tous usertype confondus, pour une comparaison
homogène) : moyenne brute non filtrée = 1129,99 s, moyenne filtrée hors >3h = 858,03 s, médiane = 578,78 s.

La **médiane est la valeur la plus robuste** : elle bouge à peine entre le jeu filtré et non filtré (par
construction, une poignée de valeurs extrêmes ne déplace jamais la valeur centrale d'une distribution),
tandis que la moyenne brute est gonflée de près de 32 % par rapport à la moyenne déjà filtrée, uniquement à
cause d'une poignée de trajets de plusieurs dizaines d'heures.

(c) Une réponse sans précaution ne serait pas seulement imprécise, elle serait **malhonnête** : donner la
moyenne brute (1130 s) sans mentionner qu'elle est tirée vers le haut par 54 trajets clairement aberrants
(0,54 % du jeu) présente une image fausse de l'usage réel du service à une direction qui va s'en servir pour
décider - la différence entre "imprécis" et "malhonnête" est que l'imprécision est involontaire, alors
qu'ici l'anomalie a été détectée et documentée (Q18-Q20) : la taire dans le chiffre final est un choix.

**R4. `explain()` ou profiler ?**

En Q31, `explain()` donne une vision **microscopique et hypothétique** : pour une requête précise que je
choisis d'écrire, il montre le plan retenu, combien de documents/clés ont été examinés, sans jamais exécuter
cette requête dans le flux réel de l'application. En Q32, le profiler donne une vision **macroscopique et
factuelle** : il capture ce qui s'est réellement passé sur la base, sans que j'aie besoin de deviner à
l'avance quelle requête est fautive - c'est lui qui m'a signalé que `end station name` et l'agrégation sur
`usertype` tournaient en `COLLSCAN`, alors que je n'aurais pas forcément pensé à tester ces deux-là avec
`explain()` en premier.

Pour un incident "l'appli est lente depuis 14h" : d'abord les **logs applicatifs** (gratuits, déjà
disponibles, permettent d'écarter en quelques secondes une cause évidente - erreur de déploiement, panne
réseau, service tiers en carafe) ; puis **`mongostat`** (quasi gratuit, vue temps réel du serveur - charge
CPU, IOPS, connexions - permet de savoir si le problème est côté base de données avant d'aller plus loin) ;
puis le **profiler** (coût modéré si déjà actif en continu au niveau 1 - identifie *quelles* requêtes
précises sont devenues lentes depuis 14h, sans avoir à les deviner) ; enfin **`explain()`** (le plus ciblé,
mais suppose de déjà savoir quelle requête regarder - sert à comprendre *pourquoi* elle est lente et à valider
la correction, par exemple un nouvel index). Cet ordre va du moins coûteux/plus général au plus coûteux/plus
précis, chaque étape servant à éliminer des hypothèses et à restreindre le périmètre avant d'investir le
temps nécessaire à un diagnostic fin.

## Bonus (facultatif)

**B1. GridFS.**

```bash
docker exec mongo-j4 mongofiles -u admin -p ipssi2025 --authenticationDatabase admin --db medias put /tmp/trips.json
```

```js
db.fs.files.findOne()
// { length: 7112796, chunkSize: 261120, uploadDate: 2026-08-27T17:31:15.634Z, filename: '/tmp/trips.json' }
db.fs.chunks.countDocuments({})   // 28
```

`length` = 7112796 octets, `chunkSize` = 261120 octets (255 Kio, la taille par défaut d'un chunk GridFS).
Nombre de chunks retrouvé par le calcul : `Math.ceil(7112796 / 261120)` = **28** - confirmé par le compte
réel. Taille du dernier chunk : `7112796 - 27*261120` = **62556 octets**, également confirmée en lisant
directement `fs.chunks.findOne({ n: 27 }).data.length()`.

Script PyMongo ([gridfs_check.py](gridfs_check.py)) qui retélécharge le fichier et vérifie la taille :

```
longueur en base : 7112796
taille de chunk : 261120
date d'upload : 2026-08-27 17:31:15.634000
taille réellement retéléchargée : 7112796
correspondance exacte : True
```

Pour un export de 7 Mo, **GridFS n'est pas justifié** : la limite qu'il contourne (16 Mo par document BSON)
n'est même pas atteinte ici, un simple document ou un fichier stocké tel quel suffirait. GridFS devient
pertinent quand le fichier dépasse réellement 16 Mo (vidéos, exports volumineux, images haute résolution) et
qu'on veut le servir en streaming par plages d'octets directement depuis la base, avec les mêmes garanties de
réplication/sharding que le reste des données. Au-delà de quelques dizaines de Mo par fichier, ou si les
fichiers n'ont pas besoin d'être interrogés comme des documents MongoDB, un stockage objet (S3 ou équivalent)
est presque toujours préférable : moins cher, conçu pour ça, et il ne charge pas le cluster applicatif avec du
trafic de fichiers binaires.

**B2. `$facet`.**

```js
db.trips.aggregate([
  { $facet: {
      total: [ { $count: "n" } ],
      parUsertype: [ { $group: { _id: "$usertype", n: { $sum: 1 } } } ],
      dureeMoyenneGlobale: [ { $group: { _id: null, moy: { $avg: "$tripduration" } } } ]
  } }
])
```

```js
{ total: [ { n: 10000 } ],
  parUsertype: [ { _id: 'Subscriber', n: 8011 }, { _id: 'Customer', n: 1989 } ],
  dureeMoyenneGlobale: [ { _id: null, moy: 1129.9943 } ] }
```

`$facet` est plus efficace que trois requêtes séparées parce qu'il ne fait **qu'un seul parcours** de la
collection source, dont il redistribue les documents vers chacune des trois sous-pipelines en parallèle -
confirmé par l'`explain()` : un unique `COLLSCAN` alimente les trois branches, là où trois `aggregate()`
indépendants auraient chacun relu les 10000 documents depuis le début.

Sa limite, précisément sur l'usage des index : toutes les sous-pipelines partagent le **même** plan d'entrée.
Si une sous-pipeline aurait pu bénéficier d'un index différent d'une autre, `$facet` ne peut pas choisir un
plan par branche - il n'y a qu'un seul scan initial pour tout le monde. Ici, aucun index n'existant sur
`usertype` ni `tripduration`, les trois branches partagent de toute façon le même `COLLSCAN`, mais le
principe reste : `$facet` optimise le nombre de parcours, pas le choix d'index par sous-pipeline.

**B3. Index partiel et TTL.**

```js
db.trips.createIndex({ usertype: 1 }, { name: "usertype_full" })
db.trips.createIndex({ usertype: 1 }, { name: "usertype_partial_customer", partialFilterExpression: { usertype: "Customer" } })
db.trips.stats().indexSizes
```

| Index | Taille |
|---|---|
| `usertype_full` (complet) | 65536 octets |
| `usertype_partial_customer` (partiel, Customer uniquement) | 28672 octets |

Gain : (65536 - 28672) / 65536 = **56,25 %**. L'index partiel ne référence que les 1989 documents Customer
(20 % du jeu) au lieu des 10000 documents, d'où un index nettement plus léger - cohérent avec la proportion
de documents couverts.

```js
db.sessions.insertMany([
  { sessionId: "s1", createdAt: new Date() },
  { sessionId: "s2", createdAt: new Date(Date.now() - 3600*1000) }
])
db.sessions.createIndex({ createdAt: 1 }, { expireAfterSeconds: 1800 })
```

Vérification concrète du TTL : `s2`, créé il y a 1h avec un `expireAfterSeconds` de 1800 s (30 min), avait
**déjà disparu** de la collection au moment du `mongodump` qui a suivi quelques minutes plus tard (seul `s1`
apparaît dans le dump) - le thread de nettoyage TTL de MongoDB (qui tourne environ chaque minute) a fait son
travail sans intervention.

**B4. Collection time-series.**

```js
db.createCollection("trips_ts", {
  timeseries: { timeField: "start time", metaField: "start station id", granularity: "hours" }
})
```

Réimport de `trips.json` dans `trips_ts` (10000 documents). Comparaison de la taille de stockage sur disque
(`storageSize`, après un `fsync` pour forcer l'écriture) :

| Collection | storageSize |
|---|---|
| `trips` (classique) | 1 155 072 octets |
| `trips_ts` (time-series) | 876 544 octets |

Gain : (1155072 - 876544) / 1155072 ≈ **24,1 %**. Le détail interne (`collStats` sur
`system.buckets.trips_ts`, la collection qui stocke réellement les données) montre en plus la compression
propre aux buckets time-series : 2 968 148 octets de mesures groupées compressés à 2 017 231 octets, soit
environ 32 % de réduction à ce niveau, avant même la compression du moteur de stockage. Les 10000 mesures ont
été regroupées en **2436 buckets** (une taille moyenne de 1898 octets par bucket).

Opérations perdues, vérifiées concrètement :
- `db.trips_ts.updateOne({}, { $set: { tripduration: 999 } })` échoue avec `Cannot perform a non-multi
  update on a time-series collection` - seules les mises à jour multi-documents (`updateMany`) sont permises.
- `db.trips_ts.createIndex({ tripduration: 1 }, { unique: true })` échoue avec `Unique indexes are not
  supported on time-series collections`.

**B5. Rejouer la démo du formateur.**

```bash
mongodump -u admin -p ipssi2025 --authenticationDatabase admin --db citibike --out /tmp/backup
mongorestore -u admin -p ipssi2025 --authenticationDatabase admin --nsFrom "citibike.*" --nsTo "citibike_test.*" /tmp/backup
```

**12899 documents restaurés** (10000 trips + 462 stations + 1 session + 2436 buckets time-series), 0 échec.

**Le point que la plupart des équipes oublient** : vérification des index de `citibike_test.trips` après
restauration.

```js
db.trips.getIndexes()
```

Les 4 index personnalisés créés plus haut (`usertype_full`, `usertype_partial_customer` avec son
`partialFilterExpression` intact, `start station location_2dsphere`, `start station id_1`) sont **tous
revenus**, en plus de `_id_`. Ils ne viennent d'aucune recréation applicative : le log de `mongorestore`
montre explicitement `restoring indexes for collection ... from metadata`, c'est-à-dire qu'ils sont
reconstruits à partir des fichiers `.metadata.json` produits par `mongodump` - la définition complète de
chaque index (y compris un filtre partiel) fait partie de la sauvegarde, pas seulement les données.

```js
db.createUser({ user: "analyste", pwd: "analyste2025", roles: [{ role: "read", db: "citibike_test" }] })
db.createUser({ user: "appli", pwd: "appli2025", roles: [{ role: "readWrite", db: "citibike_test" }] })
```

Test du moindre privilège :

| Utilisateur | Lecture | Écriture |
|---|---|---|
| `analyste` (rôle `read`) | OK (10000 documents comptés) | **Refusée** : `not authorized on citibike_test to execute command { insert: ... }` |
| `appli` (rôle `readWrite`) | OK | OK (insertion puis suppression confirmées) |

Le refus d'écriture pour `analyste` n'est pas une supposition : c'est l'erreur exacte renvoyée par le
serveur en tentant l'opération avec ses identifiants.
