# Réponses — TP Jour 3 — Réplication & haute disponibilité

## Note méthodologique

Les fichiers d'infrastructure (`docker-compose.rs.yml`, `init-rs.js`, `watch_primary.py`, `writer.py`) n'étaient
pas fournis avec le sujet — ils ont été écrits pour ce rendu, en respectant exactement les commandes et
comportements décrits dans l'énoncé. `init-rs.js` donne `priority: 2` à mongo1 et `priority: 1` aux deux autres,
ce qui explique les choix de PRIMARY observés dans tout le document.

L'URL du dataset donnée dans l'énoncé (`neelabalan/mongodb-sampledataset`) est erronée (même coquille que le
Jour 2) ; la bonne adresse est `neelabalan/mongodb-sample-dataset`.

---

## Partie 0 — Monter le Replica Set

**Q1.** Avant initialisation :
```js
db.hello()
```
→ `isWritablePrimary: false`, champ `primary` **absent**, `info: "Does not have a valid replica set config"`.
```js
db.test.insertOne({ a: 1 })
```
→ `codeName: "NotWritablePrimary"`. Conclusion : un mongod lancé avec `--replSet` mais non initialisé n'est **ni
primary ni secondary** — c'est un état intermédiaire à part, sans configuration valide.

**Q2.**
```bash
docker exec -i mongo1 mongosh < init-rs.js
# ... attendre 10s ...
docker exec mongo1 mongosh --quiet --eval 'rs.status().members.map(m => m.name + " " + m.stateStr).join(" | ")'
```
→ À +10 s : `mongo1:27017 SECONDARY | mongo2:27017 SECONDARY | mongo3:27017 PRIMARY`. Fait notable et non prévu :
la toute première élection a désigné **mongo3**, pas mongo1 ! Une seconde mesure 15 s plus tard donne
`mongo1:27017 PRIMARY | mongo2:27017 SECONDARY | mongo3:27017 SECONDARY`. Le champ qui explique le choix final est
`priority` dans `init-rs.js` (`mongo1: 2`, les autres : `1`) : mongo1 a supplanté mongo3 par un **priority
takeover**, quelques secondes après l'élection initiale.

**Q3.**
```js
db.zips.countDocuments({})              // 29470
db.zips.distinct("state").length        // 51
db.zips.aggregate([{ $group: { _id: null, total: { $sum: "$pop" } } }])   // 248709873
```
51 États, pas 50 : le jeu de données inclut le **District of Columbia** (DC) en plus des 50 États, ce qui est
correct d'un point de vue recensement (DC a ses propres codes postaux).

**Q4.**
```js
db.zips.distinct("zip").length   // 29467 (contre 29470 documents)
db.zips.aggregate([
  { $group: { _id: "$zip", n: { $sum: 1 } } },
  { $match: { n: { $gt: 1 } } }
])
// → [ { _id: '32350', n: 2 }, { _id: '42223', n: 2 }, { _id: '63673', n: 2 } ]
```
3 codes postaux apparaissent 2 fois chacun (6 documents pour 3 valeurs), soit l'écart exact de 3 entre 29470 et
29467. `zip` n'est donc **pas** une clé naturelle.
```js
db.zips.createIndex({ zip: 1 }, { unique: true })
```
→ Échec réel : `E11000 duplicate key error ... index: zip_1 dup key: { zip: "32350" }`, `codeName: "DuplicateKey"`.

**Q5.**
```js
db.zips.countDocuments({ pop: 0 })   // 67
```
67 documents. Un code postal à 0 habitant est plausible en réalité métier (zone industrielle, base militaire,
boîte postale collective, parc naturel) — ce n'est pas nécessairement une erreur de saisie, mais mérite d'être
signalé si ces zips sont utilisés dans un calcul de densité de population.
