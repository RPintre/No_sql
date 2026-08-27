# bench_shard.md - Jour 4, Partie A (census.zips)

## Q2 - Distribution initiale, clé `{ state: 1 }`

```js
db.zips.getShardDistribution()
```

```
Shard shardA at shardA/shardA:27017
{ data: '2.15MiB', docs: 29470, chunks: 1, 'estimated data per chunk': '2.15MiB', 'estimated docs per chunk': 29470 }
---
Shard shardB at shardB/shardB:27017
{ data: '1006KiB', docs: 9242, chunks: 1, 'estimated data per chunk': '1006KiB', 'estimated docs per chunk': 9242 }
---
Totals
{ data: '3.13MiB', docs: 38712, chunks: 2,
  'Shard shardA': [ '68.68 % data', '76.12 % docs in cluster' ],
  'Shard shardB': [ '31.31 % data', '23.87 % docs in cluster' ] }
```

2 chunks au total. shardA porte 68,68 % des données (76,12 % des documents comptés), shardB 31,31 % (23,87
%). Ce n'est **pas équilibré** - et on verra en Q5 que le compte de 38712 documents (au lieu des 29470
réels) est lui-même trompeur.

## Q3 - Frontières de chunks

Sortie brute (`printjson`, avant mise en forme) :

```
{ state: 'KY' }
{ state: 'MI' }
```
(bornes ordinaires : ce sont de simples valeurs `state`, rien de spécial à signaler ici)

Sortie mise en forme :

```
shardB [MinKey -> KY]
shardA [KY -> MaxKey]
```

`MinKey` et `MaxKey` sont des valeurs spéciales BSON représentant respectivement le plus petit et le plus
grand élément possible de n'importe quel type - elles bornent le tout premier et le tout dernier chunk d'une
collection shardée, pour garantir que l'espace de valeurs couvert par les chunks est toujours total (aucune
valeur de `state`, même non prévue, ne peut tomber en dehors).

La coupure a été faite sur **KY** (Kentucky). Ce n'est pas le milieu de l'alphabet (qui serait plutôt vers
M/N). Le balancer ne cherche pas à équilibrer l'alphabet : il découpe dès que la taille d'un chunk atteint le
seuil configuré (1 Mo ici), puis déplace le chunk nouvellement créé vers le shard le moins chargé en nombre
de chunks. Comme `zips.json` est trié à peu près par ordre d'insertion et non par volume égal par lettre,
c'est la masse de données accumulée jusqu'à "KY" qui a déclenché le premier split - un pur effet de l'ordre
d'import, pas une stratégie alphabétique.

## Q4 - Forcer 4 coupures supplémentaires

```js
["FL","MI","NY","TX"].forEach(s => sh.splitAt("census.zips", { state: s }))
```

### (a) Nombre de chunks

**6 chunks** après les 4 `splitAt` (shardA : 4 chunks, shardB : 2 chunks) :

```
shardA [KY -> MI]
shardA [MI -> NY]
shardA [NY -> TX]
shardA [TX -> MaxKey]
shardB [MinKey -> FL]
shardB [FL -> KY]
```

### (b) Pourcentage de documents avant / après

| | Avant (Q2) | Après Q4 |
|---|---|---|
| shardA | 76,12 % | 76,12 % |
| shardB | 23,87 % | 23,87 % |

**0 point de mouvement.** Ce n'est pas une coïncidence : `sh.splitAt` ne fait que redécouper les bornes d'un
chunk existant *sur place*, il ne déplace aucun document. Seule une migration ultérieure du balancer peut
changer la répartition par shard - et l'inspection de `config.changelog` (voir ci-dessous) confirme qu'aucune
migration n'a eu lieu après ces 4 splits, même après 90 secondes d'attente.

```js
db.getSiblingDB("config").changelog.find({ what: /moveChunk/ }).toArray()
```

Une seule entrée dans tout l'historique du cluster : la migration initiale de `[MinKey, KY)` vers shardB,
`cloned: 9242, clonedBytes: 1030265` - exactement le chunk créé par le premier auto-split. Zéro migration
après les splits de la Q4.

### (c) Explication

```js
db.zips.aggregate([{ $group: { _id: "$state", n: { $sum: 1 } } }, { $sort: { n: -1 } }, { $limit: 5 }])
```

```
TX: 1676   NY: 1596   CA: 1523   PA: 1458   IL: 1240
```

L'hypothèse "un État dépasse à lui seul un chunk entier" ne tient pas : `getShardDistribution()` indique une
taille moyenne de 111 octets par document, donc même le Texas (1676 zips) ne pèse qu'environ 1676 x 111 o
≈ 186 Ko - très loin du seuil de 1 Mo. Aucun État ne peut à lui seul saturer un chunk avec ce volume de
données.

Le vrai mécanisme est ailleurs : le balancer de MongoDB équilibre le **nombre de chunks** par shard, pas leur
volume de données. Pour une collection de moins de 20 chunks, il ne déclenche une migration que si l'écart
entre le shard le plus chargé et le moins chargé atteint **2 chunks**. Après la Q4, shardA (4 chunks) et
shardB (2 chunks) sont exactement à cet écart de 2 - pile à la limite, sans la dépasser - et aucune migration
ne s'est déclenchée dans la fenêtre d'observation. Un découpage plus fin n'égale donc pas automatiquement un
rééquilibrage : quand une seule collection reste petite et peu découpée, un seul État peut suffire à occuper
un chunk entier sans jamais forcer le balancer à agir.

## Q5 - Le piège du comptage

```js
db.zips.countDocuments({})          // 29470
db.zips.estimatedDocumentCount()    // 38712
```

### (a) Écart

38712 - 29470 = **9242**

### (b) Comparaison

9242 correspond exactement au nombre de documents de la migration initiale (`cloned: 9242` dans
`config.changelog`, voir Q4) et au compte de shardB en Q2. Ce ne sont pas deux volumes qui se ressemblent par
hasard : ce sont **les mêmes 9242 documents**, comptés deux fois - une fois à leur nouvel emplacement
(shardB), une fois à leur ancien emplacement (shardA), pas encore nettoyé.

### (c) Nom du phénomène

Ce sont des **documents orphelins** (orphaned documents) : lors d'une migration de chunk, MongoDB copie
d'abord les documents vers le shard de destination, met à jour la table de routage, puis planifie la
suppression différée des copies sur le shard source (paramètre `orphanCleanupDelaySecs`). Tant que ce
nettoyage n'a pas eu lieu, les documents existent physiquement sur les deux shards.

`estimatedDocumentCount()` est à **bannir** sur un cluster shardé : elle se contente de sommer les
métadonnées locales rapides de chaque shard, sans vérifier à qui appartient réellement chaque document, donc
elle compte les orphelins en double. `countDocuments()` est plus coûteuse parce qu'elle exécute une vraie
agrégation qui applique le filtre de propriété des chunks (shard version) avant de compter - elle est plus
lente, mais exacte.

### (d) Prédiction

Valeur par défaut de `orphanCleanupDelaySecs` : **900 secondes (15 minutes)**.

**Prédiction (formulée maintenant, avant vérification)** : 15 minutes après la migration, le nettoyeur de
plage (range deleter) doit avoir physiquement supprimé les 9242 copies orphelines sur shardA. Les deux
commandes devraient alors converger vers le même chiffre, **29470**, et l'écart de la question (a) devrait
avoir disparu.

Une anomalie qui se résorbe d'elle-même serait plus dangereuse en production qu'une anomalie permanente :
une équipe qui investigue un écart de comptage 20 minutes après l'alerte ne verrait plus rien d'anormal, alors
que le problème sous-jacent (une migration en cours, un balancer actif) se serait bel et bien produit. Le
diagnostic deviendrait non reproductible, avec le risque de conclure à tort "c'était un faux positif" et de
rater un vrai signal qui reviendrait plus tard sous une forme plus grave.

*(Vérification à faire en fin de séance, cluster laissé allumé - voir la suite du rendu.)*

### Vérification (fin de Partie B)

Le cluster shardé est resté allumé pendant toute la Partie B, comme demandé. Nouvelle exécution des deux
commandes :

```js
db.zips.countDocuments({})          // 29470
db.zips.estimatedDocumentCount()    // 29470
```

Les deux commandes renvoient désormais **le même chiffre, 29470** : l'écart de la question (a) a
effectivement disparu. La prédiction est confirmée.

## Q6 / Q7 - Targeted vs broadcast

```js
db.zips.find({ state: "NY" }).explain("executionStats")
db.zips.find({ city: "NEW YORK" }).explain("executionStats")
```

| | `{ state: "NY" }` | `{ city: "NEW YORK" }` |
|---|---|---|
| stage racine (`winningPlan.stage`) | `SINGLE_SHARD` | `SHARD_MERGE` |
| shards interrogés | shardA uniquement | shardA **et** shardB |
| stage interne par shard | `FETCH` -> `IXSCAN` (`state_1`) | `SHARDING_FILTER` -> `COLLSCAN` |
| nReturned | 1596 | 40 |
| totalDocsExamined | 1596 | 38712 |

### (a) Targeted vs broadcast

La requête sur `state` est **targeted** : `mongos` connaît la valeur de la shard key (`state`) et route
directement vers le seul shard concerné - signe net : `winningPlan.stage: 'SINGLE_SHARD'` et
`winningPlan.shards` ne contient qu'une entrée (shardA).

La requête sur `city` est **broadcast** (scatter-gather) : `city` n'est pas la shard key, `mongos` ne peut
pas savoir où se trouvent les documents, donc il interroge tous les shards et fusionne les résultats - signe
net : `winningPlan.stage: 'SHARD_MERGE'` et `winningPlan.shards` contient une entrée par shard (shardA et
shardB), chacune avec un `COLLSCAN`.

### (b) Ratio totalDocsExamined / nReturned (broadcast)

38712 / 40 = **967,8**

(mesure prise avant le nettoyage des orphelins de la Q5 - le total inclut donc les 9242 copies orphelines en
plus des 29470 documents réels ; le coût réel du scatter-gather, une fois les orphelins purgés, reste très
élevé : 29470 / 40 ≈ 736,75.)

### (c) Extrapolation à 20 shards, 500 millions de documents

Une requête broadcast n'est pas affectée par le nombre de shards de la même façon qu'une requête targeted :
elle doit interroger **les 20 shards**, quel que soit leur nombre, et chacun doit parcourir sa fraction de la
collection en `COLLSCAN`. Au total, c'est l'intégralité des **500 millions de documents** qui seraient
examinés pour ne remonter, au mieux, qu'une poignée de résultats. Ajouter des shards n'améliore rien pour ce
type de requête : le coût de la lecture croît avec le volume total de données, pas en fonction du nombre de
machines. Un cluster mal shardé (ou des requêtes qui ne filtrent jamais sur la shard key) perd tout le
bénéfice du sharding - la scalabilité horizontale ne fonctionne que si les requêtes ciblent.

## Q8 - Clé hachée `{ _id: "hashed" }`

```js
db.zips_hashed.getShardDistribution()
```

```
shardA : 14517 docs (49,26 %)
shardB : 14953 docs (50,73 %)
4 chunks au total (2 par shard), sans aucun splitAt manuel
```

Le hachage donne d'emblée cette répartition presque parfaite grâce au **pre-splitting** : quand
`sh.shardCollection` est appelé avec une clé hachée sur une collection **vide**, MongoDB crée à l'avance un
nombre de chunks vides (par défaut plusieurs par shard) répartis uniformément sur toute la plage de valeurs
de hachage possibles, avant même la première insertion. Chaque document importé est ainsi haché et routé
directement vers son chunk final dès le départ - il n'y a jamais besoin d'une migration ultérieure pour
corriger un déséquilibre.

```js
db.zips_hashed.countDocuments({})        // 29470
db.zips_hashed.estimatedDocumentCount()  // 29470
```

L'écart de la Q5 **n'existe pas** ici : précisément parce qu'aucune migration n'a jamais eu lieu sur cette
collection (le pre-splitting a placé chaque document directement à sa position finale), il n'y a jamais eu
de copie temporaire à nettoyer.

## Q9 - Le compromis, prouvé puis arbitré

```js
db.zips_hashed.find({ state: "NY" }).explain("executionStats")
```

### (a) Même requête métier, plan différent

`winningPlan.stage` vaut ici **`SHARD_MERGE`** - différent de `SINGLE_SHARD` obtenu sur `census.zips`. La
même requête métier (`{ state: "NY" }`), sur la même donnée, devient broadcast simplement parce que la shard
key a changé.

**Compromis fondamental du sharding** : une clé hachée garantit une distribution parfaitement uniforme de
l'écriture et du stockage, mais détruit toute possibilité de ciblage pour les requêtes qui filtrent sur un
autre champ que la clé elle-même (y compris le champ source du hachage) - le hachage brise l'ordre, `mongos`
ne peut plus déduire quel shard détient quelle valeur sans les interroger tous.

### (b) Tableau de décision

| Clé candidate | Cardinalité | Distribution mesurée | Requêtes métier ciblées ? | Verdict |
|---|---|---|---|---|
| `{ state: 1 }` | Moyenne (51 valeurs, très inégales : TX=1676 vs des États à quelques dizaines) | 76,12 % / 23,87 % (docs), déséquilibrée, bloquée par le seuil de balancement en nombre de chunks (Q4) | Oui, pour tout filtre sur `state` | Bon pour ce cas d'usage, mais fragile : risque de hotspot sur les gros États et de blocage du balancer tant que le nombre de chunks reste faible |
| `{ _id: "hashed" }` | Maximale (chaque `_id` est unique, hachage uniforme) | quasi parfaite : 49,26 % / 50,73 % | Non, pour aucun filtre sur `state`, `city` ou `zip` | Excellent pour l'écriture et l'équilibrage, inadapté à ce cas d'usage où les requêtes filtrent sur `state` |
| `{ zip: 1 }` | Quasi unique mais **pas unique** (Jour 3, Q4 : 29467 valeurs distinctes pour 29470 documents, 3 doublons réels, un index unique échoue avec `E11000 DuplicateKey`) | Non mesurée ici (jamais shardée sur ce champ dans ce TP) | Non, aucune requête métier de ce TP ne filtre sur `zip` | Cardinalité correcte mais ne correspond à aucun pattern de requête réel ici : deviendrait broadcast comme la clé hachée |
| `{ state: 1, zip: 1 }` | Très élevée (le couple est pratiquement unique) | Hériterait du même déséquilibre par État que `{state:1}` en tête de clé, mais `zip` permettrait de scinder plus finement les gros États en plusieurs chunks | Oui, pour tout filtre sur `state` seul (préfixe de la clé composée) et a fortiori sur `state`+`zip` ; non pour un filtre sur `zip` seul | Meilleur compromis pour ce cas d'usage : conserve le ciblage de `{state:1}` tout en affinant la granularité des chunks à l'intérieur de chaque État |
