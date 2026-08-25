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

---

## Partie 2 — Indexation & `explain()`

Voir [`index_bench.md`](index_bench.md) pour le tableau complet avant/après (Q7, Q8, Q9, Q10).

**Q7.** Avant index : `COLLSCAN`, `totalDocsExamined: 23539`, `nReturned: 105`. Après
`createIndex({ genres: 1 })` : `FETCH` (inputStage `IXSCAN`), `totalDocsExamined: 105`.

**Q8.** (a) **7761** films `{ genres: "Drama", year: { $gte: 2000 } }`. (b) Ordre ESR :
`createIndex({ genres: 1, "imdb.rating": -1, year: 1 })` — `genres` en égalité, `imdb.rating` pour le tri,
`year` en dernier (plage) : la règle ESR place le champ de tri **avant** le champ de plage pour que l'index reste
exploitable pour trier après avoir filtré sur l'égalité. (c) Aucun stage `SORT` en mémoire : le tri est couvert par
l'index (voir `index_bench.md`).

**Q9.** (a) Regex `Godfather` (sensible à la casse) : **5** films. (b) Index text + `$text: {$search:"godfather"}` :
**12** films. (c) Écart de **7**, tous trouvés via leur `plot` et non leur `title` — ex. *"Jane Austen's Mafia!"*,
*"The Nutcracker in 3D"*, *"C(r)ook"* (leur résumé mentionne "godfather" sans que ce soit dans le titre). (d)
`$text` sur "godfathers" (pluriel) renvoie aussi **12** résultats, identique à (b) : le stemming réduit "godfathers"
à la même racine que "godfather", donc même résultat — un `$regex` sur `/godfathers/` n'aurait, lui, trouvé
**aucun** des films dont le titre/plot contient "godfather" au singulier. (e) Le `$regex` reste préférable pour
chercher une **sous-chaîne qui n'est pas un mot entier** — un numéro de série, un fragment de code, une référence
partielle — car `$text` tokenise par mot entier et ne peut pas matcher un sous-mot.

**Q10.**
```js
db.movies.getIndexes()
```
→ 4 index avant suppression : `_id_` (jamais créé explicitement — existe par défaut sur toute collection),
`genres_1`, `genres_1_imdb.rating_-1_year_1`, `title_text_plot_text`.
```js
db.movies.dropIndex("title_text_plot_text")
```
→ `{ nIndexesWas: 4, ok: 1 }`. Un index inutilisé est un coût pur : il doit être mis à jour à **chaque écriture**
(insert/update/delete) sur les champs indexés, occupe de l'espace disque et RAM (working set), sans jamais
apporter de bénéfice en lecture puisqu'aucune requête ne l'utilise.

---

## Partie 3 — Agrégation analytique

Voir [`analyses.js`](analyses.js). Exécution :
```bash
docker exec -i mongo-ipssi mongosh -u admin -p ipssi2025 --authenticationDatabase admin mflix < analyses.js
```

**Q11.** Top 5 genres : Drama (13789), Comedy (7024), Romance (3665), Crime (2678), Thriller (2658).

**Q12.** Top 3 décennies : 2000 (7749 films), 2010 (5972), 1990 (3773).

**Q13.** Note IMDB moyenne des films Drama : **6,8276** sur **12377** films comptés (notes numériques uniquement).

**Q14.** Top réalisateurs : Woody Allen (40), John Ford (35), puis une **égalité à 34** entre John Huston et
Takashi Miike pour la 3ᵉ place — le pipeline `$sort: { count: -1 }` sans clé de tri secondaire ne garantit pas un
ordre déterministe entre ex æquo ; deux exécutions ont effectivement renvoyé l'un ou l'autre en position 3.

**Q15.** Top 5 films les plus commentés : *The Taking of Pelham 1 2 3* (**161**), puis **4 films à égalité à 158**
(*Terminator Salvation*, *About a Boy*, *50 First Dates*, *Ocean's Eleven*) — même remarque que Q14 sur le
non-déterminisme du tri en cas d'égalité au-delà de la 1ʳᵉ place. Le chiffre 161 confirme indépendamment le
`real_count` déjà relevé en Q4b pour ce même film.
