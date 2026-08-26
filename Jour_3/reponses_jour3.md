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

---

## Partie 2 — Lire et écrire dans un Replica Set

**Q13.**
```bash
docker exec mongo2 mongosh --quiet census --eval 'db.zips.countDocuments({})'
```
→ **29470** (lecture réussie). `mongosh` moderne, en se connectant **directement** à un membre du set (sans
`replicaSet=` dans l'URI), n'applique plus le garde-fou client historique qui bloquait les lectures sur un
secondary tant que `rs.secondaryOk()` (anciennement `slaveOk()`) n'avait pas été appelé explicitement : une
connexion directe est traitée comme une connexion à une base autonome, la restriction de lecture est déléguée au
comportement serveur plutôt qu'imposée côté client.

**Q14.**
```bash
docker exec mongo2 mongosh --quiet census --eval 'db.zips.insertOne({ test: 1 })'
```
→ `codeName: "NotWritablePrimary"`, message `"not primary"`. MongoDB autorise la lecture (le secondary a des
données à jour ou proches) mais refuse toute écriture car **seul le primary** peut produire des entrées d'oplog
faisant autorité — laisser un secondary écrire créerait deux sources de vérité divergentes.

**Q15.**
```js
rs.printSecondaryReplicationInfo()
```
→ Avant : `replLag: '0 secs'` pour mongo2 et mongo3. Après insertion de 1000 documents dans `census.charge` :
toujours `replLag: '0 secs'` pour les deux. Sur ce cluster local (réseau quasi instantané, faible volume), le
retard reste imperceptible à cette granularité — ce qui **ne contredit pas** le caractère asynchrone de la
réplication : rien ne garantit ce délai nul, c'est simplement que les conditions locales (latence réseau
minimale, faible charge) le rendent non mesurable ici. Le mécanisme reste fondamentalement asynchrone (le primary
acquitte l'écriture avant confirmation des secondaries en `w:1`).

**Q16.**
```js
db.getMongo().setReadPref("primary");   db.zips.countDocuments({ state: "NY" })   // 1596
db.getMongo().setReadPref("secondary"); db.zips.countDocuments({ state: "NY" })   // 1596
```
Résultat identique ici (pas de retard mesurable, cf. Q15). Cas où lire sur un secondary est acceptable : un
tableau de bord analytique agrégé, rafraîchi périodiquement, où quelques millisecondes/secondes de retard sont
sans conséquence. Cas dangereux : afficher le solde d'un compte ou le statut d'une commande juste après
l'écriture — une lecture *stale* sur un secondary en retard pourrait montrer une valeur périmée à l'utilisateur
qui vient de la modifier lui-même.

---

## Partie 3 — Failover : provoquer la panne et la chronométrer

Voir [`failover.md`](failover.md) pour le détail complet des commandes, sorties brutes et mesures (Q17 à Q23),
et le tableau de synthèse demandé en Q22.

**Résumé** :
- **Q17-Q18** : arrêt propre → nouveau primary (mongo2) en **0,20 s** ; `mongo1` apparaît `(not
  reachable/healthy)`, `health: 0`, vu depuis mongo2.
- **Q19-Q20** : mongo1 revient en SECONDARY, reprend PRIMARY par *priority takeover* en **11,78 s** ; 2 bascules
  au total depuis le `docker stop`. Une expérience dédiée prouve la resynchronisation par oplog (document inséré
  pendant l'absence de mongo1, retrouvé sur mongo1 à son retour).
- **Q21** : panne brutale (`docker kill`) → nouveau primary (mongo3) en **9,347 s**, soit **47× plus lent** que
  l'arrêt propre ; délai légèrement inférieur à `electionTimeoutMillis` (10 s) car le compte à rebours démarre au
  dernier heartbeat réussi, pas à l'instant du kill.
- **Q22** : tableau de synthèse dans `failover.md`.
- **Q23** : en isolant le PRIMARY (2 nœuds sur 3 arrêtés), il se rétrograde en SECONDARY plus vite que je n'ai pu
  le mesurer manuellement (les deux relevés, immédiat et +15s, sont identiques) ; écriture refusée
  (`NotWritablePrimary`), lecture toujours acceptée. Une majorité de 3 = 2 voix ; en perdre 2 ne laisse qu'1
  survivant, jamais la majorité — et un 4ᵉ nœud (majorité = 3) ne tolère pas mieux 2 pannes simultanées (2
  survivants sur 4 ≠ majorité).

---

## Partie 4 — Write Concern & Read Concern

**Q24.**
```js
db.demo.insertOne({ a: 1 }, { writeConcern: { w: 1 } })          // succès
db.demo.insertOne({ a2: 1 }, { writeConcern: { w: "majority" } }) // succès
```
`w: 1` garantit seulement que le **primary** a écrit en mémoire (pas encore forcément répliqué) ; `w: "majority"`
garantit qu'une **majorité des nœuds** a l'écriture. Dans le scénario de panne brutale de la Q21, une écriture en
`w: 1` juste avant le kill aurait pu être acquittée au client puis **perdue** si le primary tombe avant d'avoir
répliqué vers un secondary (rollback potentiel après réélection).

**Q25.**
```js
db.demo.insertOne({ a: 1 }, { writeConcern: { w: 4, wtimeout: 3000 } })
```
→ `codeName: "UnsatisfiableWriteConcern"`, message **"Not enough data-bearing nodes"**, en **3 ms** — pas 3000 ms.
MongoDB valide `w` par rapport à la topologie connue (3 nœuds data-bearing) **avant** de commencer à attendre :
`w: 4` est structurellement impossible, inutile d'attendre un timeout pour un cas qui ne peut jamais réussir.

**Q26.** (`docker stop mongo3`, un secondary, avant le test)

(a)
```js
db.demo.insertOne({ b: 1 }, { writeConcern: { w: "majority", wtimeout: 3000 } })  // succès, 11 ms
db.demo.insertOne({ c: 1 }, { writeConcern: { w: 3, wtimeout: 3000 } })
// → codeName: "WriteConcernFailed", message: "waiting for replication timed out", 3017 ms
```
`w: "majority"` passe (2 nœuds sur 3 = majorité, mongo3 non requis) ; `w: 3` échoue après le plein `wtimeout` de
3 s (il faut littéralement les 3 nœuds).

(b)
```js
db.demo.countDocuments({})   // 5
```
5 documents trouvés (`a`, `a2`, `b`, et **deux fois** `a` — dont un du test Q25 — plus `c`), alors qu'un échec
« rien n'a été écrit » n'en attendait que 3 (les 3 succès explicites : `w:1`, `w:"majority"` de Q24, `w:"majority"`
de Q26a). **Écart de 2** : les documents des deux tentatives « échouées » (`w:4` en Q25, `w:3` en Q26a) sont bel
et bien présents dans la collection.

(c) Un échec de write concern signifie « je n'ai pas pu **confirmer** que l'écriture avait atteint le niveau de
durabilité demandé dans le temps imparti » — **pas** « l'écriture n'a pas eu lieu ». Le document est écrit
localement sur le primary dès l'appel, indépendamment du succès de l'acquittement. Une application qui **rejoue**
l'écriture après avoir reçu cette erreur (en supposant « rien n'a été écrit ») créerait un **doublon**.

**Q27.**
```js
db.demo.insertOne({ d: 1 }, { writeConcern: { w: "majority", j: true, wtimeout: 3000 } })
// succès, 23 ms (contre 11 ms sans j:true)
```
`j: true` garantit en plus que l'écriture a été **journalisée sur disque** (fsync du journal WiredTiger) sur les
nœuds comptés dans `w`, pas seulement acquittée en mémoire — au prix d'une latence légèrement supérieure (23 ms
contre 11 ms ici). Sans `j: true`, si les 3 machines perdaient le courant **simultanément** avant le prochain
flush du journal, une écriture acquittée en `w:"majority"` mais non journalisée pourrait être perdue sur
redémarrage ; avec `j: true`, elle survit à cette coupure totale.

**Q28.** `readConcern: "majority"` ne renvoie que des données qu'une **majorité** du set a confirmées — des
données qui ne peuvent plus être annulées par un rollback après un futur failover. `readConcern: "local"` (le
défaut) renvoie l'état local du nœud interrogé, qui peut inclure des écritures pas encore confirmées par la
majorité — exactement le cas du document `c` de la Q26, visible localement sur le primary sans être acquitté en
majorité. Pour un utilisateur final, `"majority"` garantit qu'une donnée lue ne « disparaîtra » jamais après coup ;
`"local"` peut, dans de rares cas de bascule, faire lire une donnée qui sera ensuite annulée.

---

## Partie 5 — Résilience applicative

Voir [`resilience.md`](resilience.md) pour le détail complet (Q29 à Q33), avec les sorties brutes horodatées de
`writer.py` et le tableau retryWrites.

**Résumé** :
- **Q29** : `ServerSelectionTimeoutError` réel et intégral reproduit ; la cause est la **découverte automatique de
  topologie** (pas le paramètre `?replicaSet=`) ; `directConnection=true` la désactive (`topology_type_name:
  "Single"`, `client.primary: None`).
- **Q30** : lancé dans `rslab_default`, l'app voit `primary=('mongo1', 27017)` dès la première ligne.
- **Q31** : kill du primary pendant l'écriture → **1 seul échec** sur 32 tentatives, indisponibilité applicative
  ≈ **10,4 s** (contre 9,347 s mesurés côté cluster en Q21), reconnexion automatique sans intervention.
- **Q32** : `retryWrites` ne change rien face à un `kill` (écart nul, même exception) car il n'y a personne à qui
  reparler pendant l'absence de primary ; face à un `rs.stepDown()` en écriture rapprochée, l'écart est **net** :
  0 échec sur 271 écritures avec `retryWrites=true`, contre 1 échec sur 249 avec `retryWrites=false`.
- **Q33** : succès du script et `count_documents` **coïncident exactement** (31=31, puis 20=20 avec
  `w:"majority"`) — aucune écriture confirmée n'a été perdue dans ces scénarios.

