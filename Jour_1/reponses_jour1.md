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
