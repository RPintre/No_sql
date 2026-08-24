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
