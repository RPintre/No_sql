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

---

## Partie 4 — Drivers : PyMongo

Voir [`patterns.py`](patterns.py). Exécution : `python patterns.py` (PyMongo 4.17.0).

**Q16.** Réconciliation : sur les **15740** films portant `num_mflix_comments`, **12244** ont un compteur
incohérent avec le nombre réel de commentaires, soit **77,79 %**.

**Q17.**
```python
db.movies.bulk_write(ops)  # ops = liste d'UpdateOne, un par film incohérent
```
→ `matchedCount: 12244`, `modifiedCount: 12244`. Re-vérification de Q16 : **0** incohérence restante.

**Q18.** Subset Pattern appliqué aux 10 films les plus commentés : champ `recent_comments` ajouté avec les 3
commentaires les plus récents (`{ name, text, date }`). Vérifié sur *The Taking of Pelham 1 2 3* :
`recent_comments.length === 3`. On n'embarque que 3 commentaires (et non les 161) parce que l'usage principal
d'un aperçu "commentaires récents" sur une fiche film n'a besoin que d'un échantillon borné et petit — embarquer
la totalité romprait la borne de taille du document et redeviendrait un problème de synchronisation (comme
`num_mflix_comments`) à chaque nouveau commentaire.

---

## Partie 5 — Transaction ACID multi-documents

Voir [`transaction.js`](transaction.js), exécutée sur une instance dédiée en replica set :
```bash
docker run -d --name mongo-rs -p 27018:27017 mongo:7.0 --replSet rs0
docker exec mongo-rs mongosh --port 27017 --eval "rc = rs.initiate()"
# reimport movies.json / comments.json dans cette instance, puis :
docker exec -i mongo-rs mongosh --port 27017 mflix < transaction.js
```

**Q19.** Scénario **commit** : film *Upstream*, `num_mflix_comments` 4 → **3**, nombre réel de commentaires 3 →
**2** (suppression + décrément appliqués ensemble). Scénario **abort** : film *Wings*, une erreur métier est
simulée entre les deux écritures et `abortTransaction()` est appelé — résultat : `num_mflix_comments` reste à
**4**, le commentaire ciblé existe **toujours** en base (`comment2_existe_toujours: true`). Rien n'a été appliqué
partiellement.

Ce que garantit chaque lettre ici : **A**tomicité — la suppression du commentaire et le décrément du compteur
réussissent ou échouent ensemble, jamais l'un sans l'autre (prouvé par le scénario abort) ; **C**ohérence — le
compteur ne peut jamais être observé désynchronisé du nombre réel de commentaires à l'issue d'une transaction ;
**I**solation — aucune lecture concurrente ne peut voir un état intermédiaire (commentaire supprimé mais compteur
pas encore décrémenté) ; **D**urabilité — une fois `commitTransaction()` retourné, les deux écritures sont
persistées et survivraient à un redémarrage du nœud.

---

## Partie 6 — Réflexion

**R1. Ce que le SGBD ne fait plus pour vous.**

MongoDB ne vérifie aucune contrainte de clé étrangère : la responsabilité de l'intégrité référentielle passe
entièrement à l'application. Chiffré : **9224** commentaires orphelins (Q2) sur **50304** au total (Q1), soit
**18,34 %** de la collection `comments` qui pointe dans le vide. Deux stratégies côté application :
1. **Vérifier l'existence du film avant insertion** d'un commentaire (un `findOne` supplémentaire) — coûte une
   requête réseau de plus par écriture (latence, charge), mais ne protège pas contre une suppression *ultérieure*
   du film référencé.
2. **Job de nettoyage périodique** (agrégation `$lookup` comme en Q2, exécutée en batch) — peu coûteux en continu,
   mais laisse une fenêtre de temps où des orphelins existent réellement en base entre deux passages, donc une
   couverture seulement partielle et différée.

**R2. Embed vs reference — la borne.**

Référencer est le bon choix ici. Le film le plus commenté (Q15) porte **161** commentaires — en reprenant la
méthode du Jour 1 (R3) : un commentaire pèse **196 octets** (`bsonsize`), un document film sans les commentaires
pèse environ **2902 octets** (mesuré sur *The Taking of Pelham 1 2 3*). En imbriquant les 161 commentaires :
2902 + 161 × 196 ≈ **34 458 octets, soit ≈ 33,6 Ko** — ridiculement loin de la limite des 16 Mo. **Ce n'est donc
pas la taille qui tranche** : ce sont (a) la fréquence d'écriture indépendante — de nouveaux commentaires arrivent
en continu, sans rapport avec les mises à jour du film, et imbriquer forcerait à réécrire tout le document film à
chaque commentaire ; (b) le besoin de requêter les commentaires indépendamment des films (modération, recherche
par auteur, flux chronologique global) ; (c) une relation 1:n non bornée dans un vrai système de production, même
si elle est ici plafonnée à 161 par ce jeu de données figé. On imbriquerait quand même dans le cas précis d'un
**sous-ensemble borné et à faible cardinalité** — exactement ce que fait le Subset Pattern de Q18 (3 derniers
commentaires), où la taille et la fréquence de mise à jour redeviennent négligeables.

**R3. ESR — vérifié par l'expérience.**

Voir le détail chiffré dans [`index_bench.md`](index_bench.md#r3--vérification-expérimentale-de-la-règle-esr-index-dans-le-mauvais-ordre).
L'ordre Equality → Sort → Range est optimal parce que : le champ d'**égalité** réduit d'abord le sous-arbre du
B-tree à parcourir ; le champ de **tri** placé juste après permet à MongoDB de lire les entrées de l'index déjà
dans l'ordre voulu (pas de tri en mémoire) ; le champ de **plage** doit venir en dernier car une comparaison `$gte`
« ouvre » un intervalle continu dans l'index — le placer avant le champ de tri casserait l'ordre trié pour les
champs suivants. (a) Avec l'index dans le mauvais ordre (`genres, year, imdb.rating`), un stage `SORT` **apparaît**
bien ; `totalKeysExamined` : **7834** (bon ordre) vs **7761** (mauvais ordre) ; `totalDocsExamined` : **7761**
dans les deux cas. (b) Contre-intuitivement, le mauvais ordre examine *moins* de clés, mais le stage `SORT` en
mémoire le rend **2,4× plus lent** en pratique (55 ms vs 23 ms, mesuré) — c'est donc bien le pire des deux malgré
un `totalKeysExamined` plus favorable en apparence. (c) Si le tri en mémoire dépasse les 32 Mo autorisés par
défaut, MongoDB lève une erreur (`QueryExceededMemoryLimitNoDiskUseAllowed`) sauf si l'option `allowDiskUse: true`
est passée à l'agrégation/la requête, auquel cas le tri déborde sur disque au prix d'une latence bien plus élevée.

**R4. Patterns — le bénéfice et sa facture.**

Le champ `num_mflix_comments` illustre le Computed Pattern. **Bénéfice** chiffré : sans lui, afficher le nombre de
commentaires d'un film nécessiterait un comptage à la demande sur la collection `comments` — potentiellement pour
chacun des **14245** films effectivement référencés par au moins un commentaire (Q3), à chaque affichage de fiche
film, sur un système à fort trafic. **Risque** chiffré : sur les 15740 films portant le champ, **12244** avaient un
compteur faux avant correction (Q16), soit **77,79 %** — un taux d'erreur qui rend le champ quasiment
inexploitable tel quel avant réconciliation. Conclusion : ce pattern n'est acceptable en production qu'à condition
d'être **maintenu automatiquement et de façon atomique** à chaque écriture affectant le compteur (typiquement via
la même transaction que celle utilisée en Q19, ou un `$inc` déclenché par un trigger applicatif), et non recalculé
« un jour peut-être » en tâche de fond comme semble l'avoir été ce jeu de données.
