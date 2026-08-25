# index_bench.md — TP Jour 2, Partie 2

Tableau `explain("executionStats")` avant / après création des index, sur la base `mflix` (23539 films, 50304
commentaires).

## Q7 — Index multi-clés sur `genres`

Requête : `db.movies.find({ genres: "Film-Noir" })`

| | stage | totalDocsExamined | totalKeysExamined | nReturned |
|---|---|---|---|---|
| Avant index | COLLSCAN | 23539 | 0 | 105 |
| Après `createIndex({ genres: 1 })` | FETCH (inputStage: IXSCAN) | 105 | 105 | 105 |

## Q8 — Index composé, règle ESR (Equality, Sort, Range)

Requête : `db.movies.find({ genres: "Drama", year: { $gte: 2000 } }).sort({ "imdb.rating": -1 })`

Filtre `{ genres: "Drama", year: { $gte: 2000 } }` seul (Q8a) : **7761** films.

Index créé dans l'ordre ESR : `createIndex({ genres: 1, "imdb.rating": -1, year: 1 })`
— `genres` (égalité) → `imdb.rating` (tri) → `year` (plage).

| | stage | totalDocsExamined | totalKeysExamined | nReturned | stage `SORT` en mémoire ? | executionTimeMillis |
|---|---|---|---|---|---|---|
| Après index ESR | FETCH (inputStage: IXSCAN) | 7761 | 7834 | 7761 | **non** | 23 |

Le tri est intégralement couvert par l'index (aucun stage `SORT` en mémoire dans le plan).

## R3 — Vérification expérimentale de la règle ESR (index dans le mauvais ordre)

Second index créé volontairement dans le **mauvais ordre** :
`createIndex({ genres: 1, year: 1, "imdb.rating": -1 })` (Equality, Range, Sort au lieu de Equality, Sort, Range).

Même requête, chaque plan forcé avec `.hint()` :

| Index (via `.hint()`) | stage | totalKeysExamined | totalDocsExamined | nReturned | stage `SORT` ? | executionTimeMillis |
|---|---|---|---|---|---|---|
| `genres_1_imdb.rating_-1_year_1` (ESR, bon ordre) | FETCH | **7834** | 7761 | 7761 | non | **23** |
| `genres_1_year_1_imdb.rating_-1` (mauvais ordre) | FETCH | **7761** | 7761 | 7761 | **oui** | **55** |

Écart : l'index dans le mauvais ordre examine *moins* de clés (7761 vs 7834 — il n'a pas à parcourir les entrées
`imdb.rating` intermédiaires), mais il doit ensuite **trier 7761 documents en mémoire** (stage `SORT`), ce qui le
rend **2,4× plus lent** en temps réel (55 ms contre 23 ms) malgré un `totalKeysExamined` plus faible. Le nombre de
clés examinées ne raconte donc pas toute l'histoire : c'est le coût du tri en mémoire qui domine ici.

## Q9 — Index text

| | Résultat |
|---|---|
| `{ title: { $regex: /Godfather/ } }` (Q9a) | **5** films |
| Index `createIndex({ title: "text", plot: "text" })` puis `{ $text: { $search: "godfather" } }` (Q9b) | **12** films |
| Écart (Q9c) | **7** films trouvés uniquement par `$text` (via le champ `plot`, pas le titre) |
| `{ $text: { $search: "godfathers" } }` (Q9d, pluriel) | **12** films (identique à (b) — stemming confirmé) |

## Q10 — Index existants sur `movies`

```js
db.movies.getIndexes()
```
→ `_id_` (jamais créé explicitement, existe par défaut), `genres_1`, `genres_1_imdb.rating_-1_year_1`,
`title_text_plot_text`. L'index text a été supprimé après Q10 (`dropIndex("title_text_plot_text")`,
`nIndexesWas: 4`).
