# Diagnostic - Jour 4, Partie B5

## Q31 - `explain()` sur `db.trips.find({ "start station id": 476 })`

### (a) Avant tout index

```js
db.trips.find({ "start station id": 476 }).explain("executionStats")
```

| Métrique | Valeur |
|---|---|
| stage | `COLLSCAN` |
| totalDocsExamined | 10000 |
| nReturned | 36 |

### (b) Après création de l'index

```js
db.trips.createIndex({ "start station id": 1 })
db.trips.find({ "start station id": 476 }).explain("executionStats")
```

| Métrique | Valeur |
|---|---|
| stage | `FETCH` (inputStage: `IXSCAN` sur `start station id_1`) |
| totalKeysExamined | 36 |
| totalDocsExamined | 36 |
| nReturned | 36 |
| indexBounds | `{ "start station id": ["[476, 476]"] }` |

### (c) Ratio `totalDocsExamined / nReturned`

- Avant index : 10000 / 36 = **277,8**
- Après index : 36 / 36 = **1,0**

Le ratio idéal est **1** : chaque document examiné est un document retourné, aucun travail perdu. Ici on
l'atteint exactement parce que la requête est une égalité simple sur un champ désormais indexé : l'index
pointe directement vers les 36 documents concernés, sans en survoler un seul de trop. En général on ne
l'atteint pas aussi facilement : dès qu'une requête mélange un filtre sur un champ indexé avec un filtre
supplémentaire sur un champ non indexé, ou porte sur une plage (range) plutôt qu'une égalité, l'index
ramène un surensemble de candidats que MongoDB doit ensuite filtrer via un `FETCH` complet - d'où l'intérêt
d'un index composite couvrant tous les champs du filtre, voire d'un index couvrant (covering index) avec
projection pour éviter complètement le `FETCH`.

## Q32 - Profiler

```js
db.setProfilingLevel(1, { slowms: 0 })
db.trips.find({ "end station name": "W 52 St & 9 Ave" }).toArray()
db.trips.aggregate([{ $group: { _id: "$usertype", n: { $sum: 1 } } }]).toArray()
db.setProfilingLevel(0)
db.system.profile.find({}, { op: 1, ns: 1, millis: 1, planSummary: 1, _id: 0 }).toArray()
```

Résultat : **2 entrées** dans `system.profile`.

| op | ns | millis | planSummary |
|---|---|---|---|
| query | citibike.trips | 5 | COLLSCAN |
| command | citibike.trips | 10 | COLLSCAN |

`planSummary` vaut `COLLSCAN` pour les deux opérations : ni `end station name` ni `usertype` ne sont
indexés, donc le `find` comme l'`aggregate` parcourent l'intégralité de la collection. Le profiler confirme
ici, sans avoir à lancer `explain()` à la main sur chaque requête, que ces deux accès sont non optimisés -
c'est exactement l'usage qu'on en fait en production : repérer les COLLSCAN à partir des logs d'activité
réelle plutôt que d'auditer requête par requête.

## Q33 - Niveaux de profiling

- **0** : profiler désactivé (défaut).
- **1** : n'enregistre que les opérations plus lentes que `slowms` (0 = tout enregistrer, comme fait ci-dessus
  pour les besoins de la démonstration).
- **2** : enregistre absolument toutes les opérations, sans seuil.

En production, le niveau **1** avec un `slowms` autour de **100 à 200 ms** est l'usage recommandé : il capture
les requêtes réellement problématiques sans saturer la collection de profil ni dégrader les performances.

Deux risques du niveau 2 sur une base chargée :
1. **Surcharge d'écriture** : chaque opération (y compris les lectures triviales sur un document par `_id`)
   déclenche une écriture dans `system.profile`, ce qui ajoute une latence mesurable à *toutes* les
   requêtes, y compris celles qui n'avaient aucun problème.
2. **Perte d'historique par écrasement** : `db.system.profile.stats().capped` renvoie **`true`** - c'est une
   collection **capée** (plafonnée, ici à 1 Mo par défaut). Au niveau 2 sur une base à fort trafic, cette
   capacité se remplit en quelques secondes et les entrées les plus anciennes sont écrasées en continu ;
   l'opération lente qui a déclenché l'alerte peut très bien avoir déjà disparu au moment où on va la
   consulter.

## Q34 - Requête tableau de bord : COLLSCAN de plus de N ms

```js
var N = 100; // seuil en millisecondes, a adapter au contexte
db.system.profile.find(
  { planSummary: "COLLSCAN", millis: { $gt: N } },
  { op: 1, ns: 1, millis: 1, planSummary: 1, ts: 1, _id: 0 }
).sort({ millis: -1 })
```

C'est exactement ce type de requête qui alimente un tableau de bord de production : elle isole les
opérations qui ont à la fois parcouru la collection entière (`COLLSCAN`, donc un candidat naturel à
l'indexation) et qui ont été lentes (au-dessus du seuil métier `N`), en excluant le bruit des petites
requêtes non indexées mais rapides sur une petite collection.
