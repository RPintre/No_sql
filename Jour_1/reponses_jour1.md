# Réponses — TP Jour 1 — Introduction au NoSQL & MongoDB

## Partie 0 — Mise en place

```bash
docker compose up -d
docker compose ps

docker cp primer-dataset.json mongo-ipssi:/tmp/primer-dataset.json
docker exec mongo-ipssi mongoimport \
  --username admin --password ipssi2025 --authenticationDatabase admin \
  --db nyc --collection restaurants --drop --file /tmp/primer-dataset.json
```

```js
use nyc
db.restaurants.countDocuments({})
```
→ **25359**, conforme au point de contrôle P0.

---

## Partie 1 — Lecture & opérateurs

**Q1.**
```js
db.restaurants.countDocuments({})
```
→ **25359**

**Q2.**
```js
db.restaurants.distinct("cuisine").length
```
→ **85**

**Q3.**
```js
db.restaurants.countDocuments({ borough: "Brooklyn" })
```
→ **6086**

**Q4.**
```js
db.restaurants.countDocuments({ cuisine: "French" })
```
→ **344**

**Q5.**
```js
db.restaurants.countDocuments({ borough: "Manhattan", cuisine: "Italian" })
```
→ **621**

**Q6.**
```js
db.restaurants.countDocuments({ borough: "Bronx", cuisine: "Chinese" })
```
→ **323**

**Q7.**
```js
db.restaurants.countDocuments({ name: "Subway" })
```
→ **421**

```js
db.restaurants.find({ name: "Subway" }, { name: 1, borough: 1, _id: 0 }).limit(3)
```
→
```json
{ "borough": "Manhattan", "name": "Subway" }
{ "borough": "Manhattan", "name": "Subway" }
{ "borough": "Queens", "name": "Subway" }
```

**Q8.**
```js
db.restaurants.countDocuments({ cuisine: { $in: ["Japanese", "Korean", "Thai", "Indian"] } })
```
→ **1623**

**Q9. Le champ qui ment.**

(a)
```js
db.restaurants.countDocuments({ name: /BBQ/ })
```
→ **0**

(b)
```js
db.restaurants.countDocuments({ name: /BBQ/i })
```
→ **73**

(c) Écart : **73**. Requête utilisée pour isoler les restaurants trouvés uniquement par (b) :
```js
db.restaurants.find({ name: /BBQ/i, $nor: [{ name: /BBQ/ }] }, { name: 1, _id: 0 }).limit(5)
```
→ `"Dallas Bbq"`, `"Dallas Bbq"`, `"Virgil'S Bbq"`, `"E-Dah Korean Bbq Lounge"`, `"Goody'S Bbq"`. La base écrit
systématiquement "Bbq" (casse "titre"), jamais "BBQ" en majuscules — c'est une convention de casse du jeu de
données, pas une faute d'orthographe, qui explique pourquoi (a) renvoie 0.

(d)
```js
db.restaurants.countDocuments({ name: /House/ })     // 387
db.restaurants.countDocuments({ name: /House/i })    // 503
```
Écart : **116**. Échantillon trouvé uniquement par la version insensible à la casse : `"Peter Luger Steakhouse"`,
`"Sammy'S Steakhouse"`, `"Roadhouse Restaurant"`, `"Keens Steakhouse"`, `"The Clubhouse"`,
`"Frankie & Johnnies Steakhouse"`, `"Townhouse Of Ny"`, `"Morton'S Steakhouse"`. Cause **différente** de (a)/(b) :
ici "house" apparaît bien en toutes lettres mais **en minuscule à l'intérieur d'un mot composé**
("Steak**house**", "Club**house**", "Road**house**") — seule la première lettre du mot composé est capitalisée. Un
`$regex` sensible à la casse rate donc systématiquement les mots composés.

(e) Aucune des deux en production : (a) a des faux négatifs massifs, (b) est correcte mais **ne peut pas utiliser
d'index** (le drapeau `i` combiné à un regex non ancré force un scan complet). Troisième solution : un **index de
texte MongoDB** (`db.restaurants.createIndex({ name: "text" })` + `$text: { $search: "bbq" }`), insensible à la
casse et indexable — à construire au Jour 2.

**Q10.**
```js
db.restaurants.countDocuments({ "address.zipcode": "10462" })
```
→ **150**

**Q11.**
```js
db.restaurants.findOne({ restaurant_id: "30075445" }).name
```
→ **"Morris Park Bake Shop"**

---

## Partie 2 — Tableaux & sous-documents

**Q12.**
```js
db.restaurants.countDocuments({ "grades.score": { $gt: 50 } })
```
→ **349**

**Q13. « Mal noté » — mais quand ?**

(a)
```js
db.restaurants.countDocuments({ "grades.grade": "C" })
```
→ **2708**

(b)
```js
db.restaurants.countDocuments({ "grades.0.grade": "C" })
```
→ **220**

(c) Écart : **2488**. Le tableau `grades` de "Morris Park Bake Shop" (Q11), dans l'ordre du document :
2014-03-03, 2013-09-11, 2013-01-24, 2011-11-23, 2011-03-10 — **strictement décroissant**. L'indice 0 est donc la
note **la plus récente**. La requête (b) répond réellement à « restaurants **actuellement** mal notés » ; c'est
celle-ci que je publierais. La requête (a) mélange tout l'historique, y compris des restaurants notés C un jour puis
améliorés depuis.

**Q14.**
```js
db.restaurants.countDocuments({ grades: { $size: 0 } })
```
→ **738**. Un tableau vide traduit une inspection qui n'a pas (encore) eu lieu : restaurant récemment ouvert, fermé
avant sa première visite, ou donnée non intégrée lors de l'export — le restaurant existe mais n'a simplement pas
d'historique.

**Q15.**
```js
db.restaurants.countDocuments({ "grades.5": { $exists: true } })
```
→ **3864**

**Q16.**
```js
db.restaurants.countDocuments({ "grades.0.grade": "A" })
```
→ **20687**

**Q17. Le piège `$elemMatch`.**

(a)
```js
db.restaurants.countDocuments({ "grades.grade": "B", "grades.score": { $gt: 20 } })
```
→ **4908**

(b)
```js
db.restaurants.countDocuments({ grades: { $elemMatch: { grade: "B", score: { $gt: 20 } } } })
```
→ **4280**

(c) Écart de **628**. (a) matche dès qu'**un** élément du tableau a `grade: "B"` et qu'**un autre élément
(potentiellement différent)** a `score > 20` — les deux conditions peuvent porter sur deux notes distinctes.
`$elemMatch` en (b) exige qu'un **seul et même** sous-document vérifie les deux conditions à la fois. C'est (b) qui
répond réellement à la question métier posée.

**Q18. Anomalies de qualité, et ce qu'elles coûtent.**

(a)
```js
db.restaurants.countDocuments({ "grades.score": { $lt: 0 } })
```
→ **13** restaurants (13 notes individuelles concernées — vérifié par agrégation). Un score négatif n'a aucun sens
métier : le score NYC DOHMH est un nombre de points de pénalité, toujours ≥ 0.

Autre anomalie sur ce même champ : **13 autres notes**, sur des restaurants **différents** (aucun recouvrement
vérifié avec `$and`), ont un `score` explicitement `null` plutôt que manquant — une seconde anomalie distincte de
même ampleur.
```js
db.restaurants.aggregate([{ $unwind: "$grades" }, { $group: { _id: { $type: "$grades.score" }, n: { $sum: 1 } } }])
// → [{ _id: 'null', n: 13 }, { _id: 'int', n: 93450 }]  (total unwind = 93463)
```

(b)
```js
db.restaurants.aggregate([
  { $unwind: "$grades" },
  { $group: { _id: null, moy: { $avg: "$grades.score" } } }
])
```
→ moyenne **avec** négatifs = **11.434842161583735** (le `$avg` ignore automatiquement les 13 valeurs `null` ; le
compteur brut post-`$unwind` vaut 93463, dont 93450 notes réellement chiffrées)

```js
db.restaurants.aggregate([
  { $unwind: "$grades" },
  { $match: { "grades.score": { $gte: 0 } } },
  { $group: { _id: null, moy: { $avg: "$grades.score" } } }
])
```
→ moyenne **sans** négatifs = **11.436572235838051** (n = 93437 = 93450 − 13)

Écart : **+0.0151 %** (la moyenne sans négatifs est supérieure de 0,015 %).

(c) Non : cet écart est négligeable (0,015 % sur une moyenne de 11,43 ; 13 notes sur 93 450 valeurs chiffrées, soit
0,014 % du volume). Ces 13 scores négatifs — et les 13 scores `null` — méritent d'être corrigés pour la propreté du
modèle, mais ne justifient **aucune urgence** au vu de leur impact chiffré sur l'indicateur moyen.

**Q19.**
```js
db.restaurants.find({}, { name: 1, "grades.score": 1, _id: 0 })
  .sort({ "grades.score": -1 })
  .limit(1)
```
→ **name: "Murals On 54/Randolphs'S", score: 131**

---

## Partie 3 — Création & mise à jour

**Q20.**
```js
db.restaurants.insertOne({
  name: "RP - Restaurant Fictif TP",
  borough: "Montpellier",
  cuisine: "French",
  address: { building: "", street: "Simulation", zipcode: "", coord: [3.8767, 43.6108] },
  grades: [ { grade: "A", score: 7, date: new Date() } ]
})
```
→ `{ acknowledged: true, insertedId: ObjectId('...') }`
```js
db.restaurants.findOne({ name: "RP - Restaurant Fictif TP" })
```
→ 1 document trouvé, conforme. Total collection : **25360**.

**Q21.**
```js
db.restaurants.updateOne(
  { restaurant_id: "30075445" },
  { $push: { grades: { grade: "A", score: 3, date: new Date() } } }
)
```
→ `{ matchedCount: 1, modifiedCount: 1 }`. Ce restaurant avait 5 notes (bsonsize du document avant push : **478
octets**), il en a désormais **6** (bsonsize après push : **524 octets**).

**Q22.**
```js
db.restaurants.updateMany(
  { "grades.score": { $gt: 50 } },
  { $set: { risque: "eleve" } }
)
```
→ **matchedCount: 349, modifiedCount: 349** (identique à Q12 : le restaurant fictif de Q20, dont l'unique note a un
score de 7, n'entre pas dans ce filtre).

**Q23.**
```js
db.restaurants.updateMany(
  { cuisine: "French" },
  { $set: { label_qualite: true } }
)
```
→ **matchedCount: 345, modifiedCount: 345** (344 restaurants French d'origine + 1 : le restaurant fictif inséré en
Q20, lui aussi `cuisine: "French"`).

---

## Partie 4 — Suppression & qualité de données

**Q24.**
```js
db.restaurants.countDocuments({ borough: "Missing" })
```
→ **51**

**Q25.**
```js
db.restaurants.deleteMany({ borough: "Missing" })
```
→ `{ deletedCount: 51 }`
```js
db.restaurants.countDocuments({})
```
→ **25309**

**Q26.**

(a)
```js
db.restaurants.countDocuments({ grades: { $size: 0 } })
```
→ **737** (738 en Q14, moins 1 : l'un des 51 documents `borough: "Missing"` supprimés en Q25 avait justement un
tableau `grades` vide). Rapporté à l'effectif actuel (25309) : **737 / 25309 ≈ 2,91 %**.

(b) Les deux anomalies ne sont pas de même nature. `borough: "Missing"` est **irrécupérable** : rien dans le
document ne permet de déduire l'arrondissement réel — le document est corrompu sans valeur d'usage. Un tableau
`grades` vide est une **absence d'information légitime et temporaire** (le restaurant existe, n'a simplement pas
encore été inspecté) : le document reste exploitable pour toute requête ne portant pas sur `grades`. On supprime ce
qui est cassé, on conserve ce qui est seulement incomplet.

---

## Partie 5 — Automatisation

**Q27.** Voir [`rapport.js`](rapport.js). Exécution :
```bash
docker exec -i mongo-ipssi mongosh -u admin -p ipssi2025 --authenticationDatabase admin nyc < rapport.js
```
Sortie :
- **Total : 25309**
- **Top 5 cuisines** : American (6173), Chinese (2412), Café/Coffee/Tea (1210), Pizza (1162), Italian (1069)
- **Par arrondissement** : Bronx 2338, Brooklyn 6086, Manhattan 10259, **Montpellier 1**, Queens 5656,
  Staten Island 969

En construisant ce classement, `db.restaurants.distinct("cuisine")` fait apparaître deux valeurs quasi identiques :
`"Café/Coffee/Tea"` (1210 restaurants) et `"CafÃ©/Coffee/Tea"` (2 restaurants) — un double encodage UTF‑8/Latin‑1 du
"é" stocké en base. Ce sont donc 84 cuisines réellement distinctes, pas 85 (Q2).

**Écart entre le total (25309) et Q1 (25359) : −50.**

| Opération | Effet sur le total |
|---|---|
| Q1 (état initial) | 25359 |
| Q20 — `insertOne` (restaurant fictif) | +1 → 25360 |
| Q21 — `$push` (ajoute une note, pas un document) | 0 → 25360 |
| Q22 — `updateMany` (ajoute un champ, pas un document) | 0 → 25360 |
| Q23 — `updateMany` (ajoute un champ, pas un document) | 0 → 25360 |
| Q25 — `deleteMany({ borough: "Missing" })` | −51 → 25309 |
| **Total final** | **25309** (25359 − 50) |

La liste des arrondissements contient désormais **"Montpellier"** (issu du restaurant fictif de Q20), et
**"Missing" a disparu** (51 documents supprimés en Q25).

**Q28.**
```bash
docker exec mongo-ipssi mongoexport \
  --username admin --password ipssi2025 --authenticationDatabase admin \
  --db nyc --collection restaurants \
  --queryFile /tmp/_query.json \
  --out /tmp/staten_island.json
# _query.json contient : {"borough":"Staten Island"}
```
Sortie mongoexport : `exported 969 records`.
```js
db.restaurants.countDocuments({ borough: "Staten Island" })
```
→ **969** — confirmé par comptage de lignes du fichier exporté (`staten_island.json`, joint).

---

## Partie 6 — Réflexion

**R1. Les 5 V, chiffrés.**

- **Volume** : 25 359 restaurants (Q1) portant 93 463 sous-documents de notes au total, dont 93 450 avec un score
  chiffré (Q18b) — un `find()` sans index sur ce volume dégénère vite en scan complet.
- **Variété** : 85 valeurs de `cuisine` distinctes déclarées (Q2), structure hétérogène combinant scalaires
  (`name`, `borough`), sous-document (`address` avec `coord`), et tableau de sous-documents de taille variable — de
  0 élément (738 restaurants, Q14) à 6 éléments ou plus (3864 restaurants, Q15).
- **Véracité** : le champ censé être fiable ne l'est pas toujours, à plusieurs niveaux vérifiés dans ce TP. 13 notes
  ont un score négatif absurde (Q18a) et 13 autres un score `null` (découverte Q18), mais l'impact sur la moyenne
  globale n'est que de 0,015 % (Q18b) — négligeable. À l'inverse, 51 documents ont un `borough: "Missing"`
  totalement irrécupérable (Q24), et même le champ `cuisine`, en apparence propre, contient un doublon d'encodage :
  `"Café/Coffee/Tea"` (1210 restaurants) et `"CafÃ©/Coffee/Tea"` (2 restaurants) sont la même valeur corrompue deux
  fois (Q2/Q27) — le vrai nombre de cuisines distinctes est 84, pas 85.

**R2. CAP & BASE, appliqué à ce service.**

Prenons "Morris Park Bake Shop" (Q11) : il vient d'être fermé pour insalubrité, écriture qui survient au moment
précis d'une partition réseau entre deux datacenters.

- **(a) Si l'on choisit C (cohérence)** : le nœud qui ne peut pas garantir avoir la dernière version refuse de
  répondre plutôt que de renvoyer une donnée potentiellement périmée. L'usager voit une erreur ou une
  indisponibilité temporaire, mais **jamais** l'ancienne note à la place de la fermeture.
- **(b) Si l'on choisit A (disponibilité)** : le service répond toujours, y compris depuis un réplica qui n'a pas
  encore reçu l'écriture de fermeture. L'usager peut voir "Morris Park Bake Shop — Grade A" et s'y rendre, alors que
  le restaurant vient d'être fermé pour insalubrité.

Je tranche pour **C**. Pour un service de santé publique, le dommage d'une indisponibilité de quelques secondes est
sans commune mesure avec celui d'envoyer quelqu'un manger dans un établissement fermé pour insalubrité sur la foi
d'une donnée périmée. Le dommage accepté en choisissant C est un dommage de **disponibilité** : pendant la
partition, une partie des usagers n'a tout simplement pas accès à l'information, plutôt que d'avoir accès à une
information potentiellement fausse — cohérent avec le choix par défaut de MongoDB (système **CP**).

**R3. Embarqué vs référencé — le calcul.**

(a) 3864 restaurants ont au moins 6 notes (Q15) ; le restaurant modifié en Q21 en a désormais 6. Mesures avec
`bsonsize()` dans `mongosh` sur `restaurant_id: "30075445"` :
- document sans aucune note (`grades: []`) : **248 octets**
- une note isolée : **43 octets**
- document complet avec 5 notes (avant Q21) : **478 octets** — cohérent avec 248 + 5×43 = 463 octets, l'écart
  provenant du léger surcoût d'index de tableau BSON
- document complet avec 6 notes (après Q21) : **524 octets**

(b) 520 notes (une inspection hebdomadaire pendant 10 ans) donneraient un document d'environ
248 + 520 × 43 ≈ **22 608 octets, soit ≈ 22,1 Ko**. La taille maximale d'un document BSON est de **16 Mo**
(16 777 216 octets). 22,1 Ko ne représente que **≈ 0,135 %** de cette limite : le modèle embarqué **tient très
largement** pour ce cas d'usage réel.

(c) **Avantage** : un seul accès (`findOne`) suffit pour récupérer un restaurant et tout son historique de notes,
sans jointure (`$lookup`). **Limite** : le tableau ne fait que grossir (aucune purge dans ce modèle), et toute
écriture (`$push`) réécrit potentiellement le document entier ; un pattern d'usage plus intense (capteurs,
événements très fréquents) ferait grossir le tableau vers des dizaines de milliers d'éléments. Compte tenu du
calcul ci-dessus, je basculerais vers un modèle référencé (collection `grades` séparée avec `restaurant_id` en clé
étrangère) à partir de quelques milliers de notes par restaurant (par exemple > 5000) — bien avant la limite des 16
Mo, mais au point où le document devient disproportionné par rapport aux besoins réels de lecture, qui ne portent le
plus souvent que sur les dernières notes.

---

## Pour aller plus loin (facultatif)

Mesure prise sur la collection dans son état **final** (après Q20-Q23 et Q25 de la Partie 3-4 : 25309 documents,
345 de cuisine French), et non sur l'import brut — la Q23 ajoute un restaurant French (344→345) et la Q25 retire
des documents (25359→25309), ce qui change le résultat ci-dessous par rapport à un import vierge.

**B1. Index.**
```js
db.restaurants.find({ cuisine: "French" }).explain("executionStats")
```
Avant l'index : `stage: "COLLSCAN"`, `totalDocsExamined: 25309`, `totalKeysExamined: 0`, `nReturned: 345`,
`executionTimeMillis: 12`.

```js
db.restaurants.createIndex({ cuisine: 1 })
```
→ `"cuisine_1"`

```js
db.restaurants.find({ cuisine: "French" }).explain("executionStats")
```
Après l'index : le stage racine devient `"FETCH"` avec un `inputStage` en **`"IXSCAN"`** (donc COLLSCAN → IXSCAN).
`totalDocsExamined` passe de **25309 à 345** (exactement le nombre de documents retournés — l'index cible
directement les bons documents au lieu de scanner toute la collection), `totalKeysExamined: 345`,
`executionTimeMillis: 1` (contre 12 sans index).
