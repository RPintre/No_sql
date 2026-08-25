# Réponses — TP Jour 2 — Modélisation, Indexation & Drivers

## Partie 0 — Import des données réelles

Note : l'URL fournie dans l'énoncé (`neelabalan/mongodb-sampledataset`) renvoie une 404 — le dépôt réel s'appelle
`neelabalan/mongodb-sample-dataset` (avec un tiret). Commandes utilisées :

```bash
curl -L -o movies.json https://raw.githubusercontent.com/neelabalan/mongodb-sample-dataset/main/sample_mflix/movies.json
curl -L -o comments.json https://raw.githubusercontent.com/neelabalan/mongodb-sample-dataset/main/sample_mflix/comments.json
wc -l movies.json comments.json
```
→ 23539 et 50304 lignes, conforme.

```bash
docker cp movies.json mongo-ipssi:/tmp/movies.json
docker cp comments.json mongo-ipssi:/tmp/comments.json
docker exec mongo-ipssi mongoimport -u admin -p ipssi2025 --authenticationDatabase admin \
  --db mflix --collection movies --drop --file /tmp/movies.json
docker exec mongo-ipssi mongoimport -u admin -p ipssi2025 --authenticationDatabase admin \
  --db mflix --collection comments --drop --file /tmp/comments.json
```

```js
db.movies.countDocuments({})     // 23539
db.comments.countDocuments({})   // 50304
```
→ Point de contrôle P0 conforme.

---

## Partie 1 — Modélisation & intégrité référentielle

**Q1.**
```js
db.movies.countDocuments({})
db.comments.countDocuments({})
db.movies.distinct("genres").length
```
→ **23539** films, **50304** commentaires, **25** genres distincts.

**Q2.**
```js
db.comments.aggregate([
  { $lookup: { from: "movies", localField: "movie_id", foreignField: "_id", as: "movie" } },
  { $match: { movie: { $size: 0 } } },
  { $count: "orphans" }
])
```
→ **9224** commentaires orphelins.

**Q3.**
```js
db.comments.aggregate([
  { $group: { _id: "$movie_id" } },
  { $count: "n" }
])
```
→ **14245** films distincts référencés par au moins un commentaire.

**Q4. Computed Pattern — première question d'écart.**

(a)
```js
db.movies.countDocuments({ num_mflix_comments: { $exists: true } })
```
→ **15740** films sur 23539, soit **66,87 %**.

(b)
```js
db.movies.findOne({ title: "The Taking of Pelham 1 2 3" }, { num_mflix_comments: 1 })
db.comments.countDocuments({ movie_id: <son _id> })
```
→ `num_mflix_comments` affiché : **437**. Nombre réel de commentaires : **161**.

(c) Écart absolu : **276** (437 − 161). En pourcentage de la valeur réelle : **+171 %** (le compteur affiche
2,71× le nombre réel). Le compteur **sur-estime** très largement.

(d) Un utilisateur qui clique sur ce film voit « 437 commentaires » affiché, puis n'en trouve que 161 en réalité
— une différence flagrante et embarrassante pour le produit. Cet écart révèle le risque structurel des
compteurs dénormalisés (pattern Computed) : rien ne garantit leur synchronisation avec la collection source une
fois que celle-ci évolue (suppressions, imports partiels, bugs applicatifs) — sans mécanisme de réconciliation
explicite, ils dérivent silencieusement.

**Q5.**
```js
db.movies.countDocuments({ year: { $type: "string" } })
```
→ **37** films. Une requête `{ year: { $gte: 2000 } }` compare uniquement des valeurs de **même type BSON** par
défaut (comparaison type-bracketée) : les 37 documents où `year` est une chaîne ne sont ni exclus par erreur ni
signalés, ils sont juste **silencieusement ignorés** du résultat — aucune erreur, aucun avertissement.

**Q6.**
```js
db.movies.countDocuments({ "imdb.rating": "" })
```
→ **61** films. Piège pour une moyenne : `$avg` sur `"imdb.rating"` sans filtre de type inclurait potentiellement
ces chaînes vides selon l'opérateur utilisé, ou plus insidieusement, un calcul fait côté application (Python,
`sum()/len()`) sur les valeurs brutes ferait planter le programme ou fausserait silencieusement le compte du
dénominateur si les `""` sont mal filtrées.
