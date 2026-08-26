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

---

## Partie 1 — Anatomie du Replica Set et de l'oplog

**Q6.**
```js
rs.conf().settings
```
→ `electionTimeoutMillis: 10000`, `heartbeatIntervalMillis: 2000`. « Un secondary déclare le primary mort au bout
de **10 secondes** sans réponse, alors qu'il l'interroge toutes les **2 secondes**. »

**Q7.**
```js
rs.status().members
```
→ `mongo1 PRIMARY health=1 lastHeartbeat=undefined` (un primary ne s'auto-heartbeat pas), `mongo2 SECONDARY
health=1 lastHeartbeat=<horodatage>`, `mongo3 SECONDARY health=1 lastHeartbeat=<horodatage>`. En production, c'est
le champ **`health`** (0 ou 1) qui signale directement un nœud injoignable — `stateStr` peut afficher un état
figé pendant un court instant, `health` bascule dès l'échec du dernier heartbeat.

**Q8.**
```js
db.getSiblingDB("local").oplog.rs.stats().maxSize   // 134217728
```
= exactement **128 Mo** (134217728 = 128×1024×1024), fixé explicitement par `--oplogSize 128` dans
`docker-compose.rs.yml`. Sans cette valeur, MongoDB calcule une taille par défaut (habituellement ~5 % de l'espace
disque libre, avec un plancher), ce qui rendrait le dimensionnement imprévisible et non reproductible d'une
machine à l'autre — exactement ce que ce TP veut éviter.

**Q9.**
```js
db.getSiblingDB("local").oplog.rs.countDocuments({ op: "i", ns: "census.zips" })   // 29470
```
Égalité exacte avec les 29470 documents importés : la réplication opère à la granularité du **document
individuel**, jamais par lot — même si `mongoimport` envoie ses données en lots réseau de plusieurs milliers de
documents, l'oplog contient une entrée par document inséré.

**Q10.**
```js
db.getSiblingDB("local").oplog.rs.findOne({ op: "i", ns: "census.zips" })
```
→ `op: "i"`, `ns: "census.zips"`, `o`: le **document complet** inséré, `ts`: l'horodatage logique (Timestamp),
`wall`: l'horodatage mur. Le champ `o` contient le document entier (pas un delta) : rejouer deux fois « insère ce
document précis » produit le même état final (le serveur applique l'opération comme un remplacement basé sur
`_id`), ce qui rend l'opération idempotente.

**Q11.**
```js
db.zips.updateMany({ state: "TX" }, { $inc: { pop: 1 } })
// matchedCount: 1676, modifiedCount: 1676
db.getSiblingDB("local").oplog.rs.findOne({ op: "u", ns: "census.zips" })
```
→ `o: { '$v': 2, diff: { u: { pop: 40833 } } }`. **Pas de `$inc`** dans l'oplog : MongoDB y stocke la **valeur
finale calculée** (40833), jamais l'opérateur relatif. Un `$inc` rejoué deux fois incrémenterait deux fois — en
stockant le résultat absolu, l'oplog reste idempotent quel que soit le nombre de fois où l'entrée est rejouée,
exactement pour la même raison qu'en Q10.

**Q12.**
```js
db.getSiblingDB("local").oplog.rs.stats()   // size: 12020202, count: 31185
```
(a) Taille moyenne : 12020202 / 31185 = **385,45 octets/opération**.
(b) Capacité : 134217728 / 385,45 ≈ **348212 opérations** avant écrasement des plus anciennes.
(c) À 300 écritures/s : 348212 / 300 ≈ **1160,7 s ≈ 19,35 minutes** de fenêtre de réplication. Un secondary tombé
vendredi 18h ne peut **absolument pas** rattraper par l'oplog jusqu'au lundi 9h (écart de 63 heures, soit plus de
**195 fois** la fenêtre disponible) : l'oplog aurait tourné en boucle des dizaines de fois. Passé ce délai, la
seule option est une **resynchronisation complète** (initial sync) — copie intégrale des données depuis un autre
membre, une opération beaucoup plus lourde et longue qu'un simple rattrapage d'oplog.
