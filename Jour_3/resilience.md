# resilience.md — TP Jour 3, Partie 5

## Q29 — le piège de l'URI (depuis le poste hôte, hors réseau Docker)

Tentative avec la liste complète et `?replicaSet=rs0` :
```
ServerSelectionTimeoutError
mongo1:27017: [Errno 11001] getaddrinfo failed (...), mongo2:27017: [Errno 11001] getaddrinfo failed (...),
mongo3:27017: [Errno 11001] getaddrinfo failed (...), Timeout: 5.0s,
Topology Description: <TopologyDescription ... topology_type: ReplicaSetNoPrimary, servers: [
  <ServerDescription ('mongo1', 27017) server_type: Unknown, error=AutoReconnect('mongo1:27017: [Errno 11001] getaddrinfo failed ...')>,
  <ServerDescription ('mongo2', 27017) server_type: Unknown, error=AutoReconnect('mongo2:27017: [Errno 11001] getaddrinfo failed ...')>,
  <ServerDescription ('mongo3', 27017) server_type: Unknown, error=AutoReconnect('mongo3:27017: [Errno 11001] getaddrinfo failed ...')>
]>
```

**(a)** Le driver a tenté de joindre `mongo1`, `mongo2`, `mongo3` — pas les `localhost:2701x` fournis dans l'URI.

**(b)/(c)** Nouvelle tentative sur `mongodb://localhost:27017` seul (sans `?replicaSet=rs0`) : **échec identique**,
avec exactement les mêmes noms `mongo1`/`mongo2`/`mongo3` dans la Topology Description. L'hypothèse initiale
(« c'est le paramètre `?replicaSet=` qui force le remplacement ») est donc fausse. `db.hello()` sur mongo1 confirme :
```js
setName: 'rs0', hosts: ['mongo1:27017', 'mongo2:27017', 'mongo3:27017']
```
Dès que le driver se connecte à un nœud qui se déclare membre d'un replica set (champ `setName`/`hosts` de
`hello()`), il **découvre automatiquement la topologie complète** et remplace la liste de seeds fournie par la
vraie liste des membres — que `replicaSet=` soit précisé ou non.

**(d)** Option qui désactive la découverte : `directConnection=true`.
```
mongodb://localhost:27017/?directConnection=true
```
→ Connexion réussie. `client.topology_description.topology_type_name` = **`"Single"`**,
`client.primary` = **`None`**. Ce qu'on perd : toute connaissance du replica set côté driver — pas de
bascule automatique en cas de panne de ce nœud précis, pas de routage de lecture par préférence.

## Q30 — lancement dans le réseau du cluster (`--network rslab_default`)

5 premières lignes (horodatage conteneur, en UTC) :
```
08:36:58.205 seq=1 OK   primary=('mongo1', 27017) dt=0.040s
08:36:59.244 seq=2 OK   primary=('mongo1', 27017) dt=0.005s
08:37:00.249 seq=3 OK   primary=('mongo1', 27017) dt=0.020s
08:37:01.270 seq=4 OK   primary=('mongo1', 27017) dt=0.005s
08:37:02.275 seq=5 OK   primary=('mongo1', 27017) dt=0.004s
```
Primary vu par l'application : **mongo1:27017**.

## Q31 — kill du primary pendant l'écriture (run dédié, `retryWrites=true`)

Sortie brute complète (horodatage conteneur) :
```
08:38:50.124 seq=1  OK   primary=('mongo1', 27017) dt=0.042s
...
08:39:00.206 seq=11 OK   primary=('mongo1', 27017) dt=0.020s
08:39:01.227 seq=12 OK   primary=('mongo1', 27017) dt=0.005s
08:39:02.232 seq=13 OK   primary=('mongo1', 27017) dt=0.005s
[KILL mongo1 ici — 08:39:02.379 (converti en UTC conteneur)]
08:39:03.237 seq=14 FAIL primary=None dt=5.153s error=ServerSelectionTimeoutError: No primary available for writes, ...
08:39:09.391 seq=15 OK   primary=('mongo3', 27017) dt=3.394s
08:39:13.785 seq=16 OK   primary=('mongo3', 27017) dt=0.004s
08:39:14.789 seq=17 OK   primary=('mongo3', 27017) dt=0.006s
08:39:15.795 seq=18 OK   primary=('mongo3', 27017) dt=0.004s
08:39:16.799 seq=19 OK   primary=('mongo3', 27017) dt=0.003s
...
08:39:29.852 seq=32 OK   primary=('mongo3', 27017) dt=0.004s

Total: success=31 failure=1 (attendues=32)
count_documents reel dans census.heartbeat: 31
```

**(a)** Une seule ligne en échec (seq=14, débutée à 08:39:03.237, échouée après 5,153 s → fin ≈ 08:39:08.390).
Première ligne redevenue OK : seq=15, débutée à 08:39:09.391, réussie après 3,394 s de nouvelle découverte de
topologie → écriture effective ≈ 08:39:12.785. **Indisponibilité applicative totale ≈ 10,4 s** (de la fin de
seq=13 à la fin de seq=15).

**(b)** 31 écritures réussies, 1 échouée, sur 32 tentatives.

**(c)** Oui — le driver s'est reconnecté seul, sans aucune intervention : la ligne `seq=15` montre le changement de
primary (`mongo1` → `mongo3`) de façon totalement transparente pour le code applicatif.

**(d)** Comparée à la Q21 (9,347 s mesurés côté cluster), la mesure applicative (≈10,4 s) est **très proche mais
légèrement supérieure** : l'écart (~1 s) correspond au temps supplémentaire que le driver met pour
re-sélectionner un serveur et rouvrir une connexion applicative après que le cluster a lui-même fini d'élire un
nouveau primary — un coût de découverte de topologie côté client, en plus du délai d'élection côté serveur.

## Q32 — `retryWrites` : ce qui ne le distingue pas, puis ce qui le distingue

**(a)** Même scénario (kill), `retryWrites=false` : `success=30, failure=1` — **écart nul** avec le run
`retryWrites=true` (1 échec dans les deux cas).

**(b)** Type d'exception identique dans les deux cas : `ServerSelectionTimeoutError`. Explication : pendant un
`docker kill`, il n'existe **aucun primary joignable pendant ≈9,35 s** (Q21). `retryWrites` ne rejoue une écriture
qu'**après** avoir trouvé un serveur à qui la soumettre — tant qu'aucun primary n'existe, il n'y a personne à qui
reparler, donc rien à rejouer. Le driver attend simplement `serverSelectionTimeoutMS` (5000 ms, fixé dans
`writer.py`) avant d'abandonner, qu'il y ait retry ou non.

**(c) L'expérience qui prouve** — `rs.stepDown(20)` sur le primary vivant, avec une écriture **en boucle serrée**
(une insertion toutes les 50 ms, script `_tight_writer.py`, pour capturer l'instant exact du stepdown) :

| | `retryWrites=true` | `retryWrites=false` |
|---|---|---|
| Résultat | **success=271, failure=0** | success=248, **failure=1** |
| Erreur (si échec) | — | `ServerSelectionTimeoutError: No primary available for writes` |

**Écart net** : avec `retryWrites=true`, le stepdown est **totalement absorbé**, invisible pour l'application.
Avec `retryWrites=false`, la même bascule produit une erreur visible. Contrairement au `docker kill` (b), un
`stepDown()` laisse le nœud vivant et joignable : le driver reçoit une erreur "not primary" quasi immédiate (pas
un timeout de sélection de serveur) et peut, avec `retryWrites=true`, retenter l'opération une fois contre le
nouveau primary dès qu'il est élu — ce qui fonctionne car l'ancien nœud reste là pour signaler le changement,
contrairement à un nœud mort qui ne signale plus rien.

**(d)** `retryWrites` ne peut rejouer sans risque de doublon que pour des écritures **porteuses d'un identifiant de
session et de déclaration uniques** (`lsid` + `txnNumber` + `stmtId`, vus dans l'entrée d'oplog de la Q10) : le
serveur peut alors reconnaître « cette déclaration a déjà été exécutée » et renvoyer le résultat déjà obtenu au
lieu de ré-exécuter l'opération. `insertOne`/`updateOne`/`deleteOne` (et leurs équivalents à un seul document)
portent cet identifiant. `updateMany` et `deleteMany` ne le portent **pas** de la même façon : ils affectent un
nombre variable de documents, et rejouer un `updateMany` après un échec partiel pourrait produire un résultat
différent (documents entre-temps modifiés par ailleurs, ou déjà partiellement appliqué) — MongoDB refuse donc de
les rejouer automatiquement pour éviter une double-application incohérente.

## Q33 — décompte final

**(a)** Run de référence (Q31, kill, `retryWrites=true`) : `success=31`, `count_documents=31` — **écart = 0**.

**(b)** Même scénario avec `w=majority` forcé dans l'URI (`&w=majority`) : `success=20`, `count_documents=20` —
**écart toujours nul**. Forcer `w:"majority"` ne change rien ici car l'unique échec est un échec de **sélection de
serveur** (aucun primary joignable), pas un échec de **confirmation** d'une écriture déjà passée localement (le
cas contraire est celui de la Q26, avec un nœud secondaire manquant mais un primary toujours présent).

**(c) Le chiffre annoncé à la DSI** : « Lors d'une panne serveur brutale, notre service est indisponible en
écriture pendant environ **9 à 10 secondes** (9,35 s mesurés côté cluster, ≈10,4 s vus par l'application) et ne
perd **aucune écriture confirmée au client** dans ce scénario précis, à condition que l'application utilise
`retryWrites=true` et considère toute absence de réponse pendant cette fenêtre comme un état transitoire à
retenter — et non comme un échec définitif. »
