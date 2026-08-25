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
