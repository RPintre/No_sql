# failover.md — TP Jour 3, Partie 3

Mesures réelles effectuées sur ce cluster (3 nœuds `mongo1`/`mongo2`/`mongo3`, `electionTimeoutMillis: 10000`,
`heartbeatIntervalMillis: 2000`), via `watch_primary.py` connecté en direct sur `mongo2` (sondage toutes les 300 ms).

## Tableau de synthèse (Q22)

| Scénario | Commande | Délai mesuré | Nœud élu | Écritures perdues ? |
|---|---|---|---|---|
| Arrêt propre | `docker stop mongo1` | **0,20 s** (10:27:35.511 → 10:27:35.709) | mongo2 | Non observées |
| Panne brutale | `docker kill mongo1` | **9,35 s** (10:30:18.307 → 10:30:27.654) | mongo3 | Non observées (aucune écriture en cours à ce moment précis) |
| Retour du nœud | `docker start mongo1` | **~2-3 s** pour redevenir SECONDARY joignable, puis **+11,78 s** de "priority takeover" avant de redevenir PRIMARY (10:28:28.890 → 10:28:40.671) | — | — |

**Écart mesuré arrêt propre vs panne brutale : facteur ≈ 47×** (9,35 s / 0,20 s).

## Détail des mesures brutes

### Q17-Q18 — arrêt propre (`docker stop mongo1`)

```
STOP_START: 10:27:35.511185200
STOP_DONE:  10:27:39.029387500   (docker attend jusqu'à 10 s avant SIGKILL, mais mongod a deja quitte avant)
```
Log `watch_primary.py` :
```
[10:27:25.736] (+   0.01s) primary = mongo1:27017
[10:27:35.709] (+   9.98s) primary = mongo2:27017
```
→ Nouveau primary détecté à 10:27:35.709, soit **0,198 s après la commande `docker stop`** — bien avant tout
timeout d'élection : un arrêt propre déclenche un `stepDown` proactif du primary, qui prévient aussitôt le set.

`rs.status()` depuis mongo2 pendant la bascule :
```json
{ "name": "mongo1:27017", "stateStr": "(not reachable/healthy)", "health": 0 }
```

### Q19 — retour de mongo1 et priority takeover

```
START_TIME: 10:28:28.890233500
```
État immédiat de mongo1 : `isWritablePrimary: false, secondary: true` (SECONDARY, comme attendu).

Log :
```
[10:28:40.671] (+  74.94s) primary = mongo1:27017
```
→ mongo1 redevient PRIMARY **11,78 s** après le `docker start` (`rs.conf().members[0].priority = 2`, contre
`priority: 1` pour mongo2/mongo3 — c'est un *priority takeover*, une élection volontaire déclenchée dès que le
nœud prioritaire a rattrapé son retard). **2 bascules** ont eu lieu depuis le `docker stop` initial (mongo1→mongo2,
puis mongo2→mongo1).

Fait notable : ce même mécanisme de priority takeover s'était déjà produit **à l'initialisation du set** (Partie
0.3) : la toute première élection a désigné mongo3 PRIMARY (à +10 s), puis mongo1 (priority 2) l'a supplanté ~15 s
plus tard — avant même le premier `docker stop` de la Partie 3.

### Q20 — preuve de la resynchronisation par oplog

Test dédié : `docker stop mongo1`, insertion de `{zip:"99999", city:"TESTVILLE", ...}` sur le primary temporaire
(mongo2), puis `docker start mongo1` et lecture **directement sur mongo1** :
```js
db.zips.findOne({zip:"99999"})
// → { _id: ObjectId('...'), zip: '99999', city: 'TESTVILLE', state: 'ZZ', pop: 1234, loc: {x:0,y:0} }
```
Le document est bien présent : mongo1 a rejoué, à son retour, les entrées de l'**oplog** produites en son absence
(mécanisme vu en Partie 1).

### Q21 — panne brutale (`docker kill mongo1`)

```
KILL_TIME: 10:30:18.307635800
```
Log :
```
[10:30:18.588] (+ 172.86s) primary = None
[10:30:27.654] (+ 181.93s) primary = mongo3:27017
```
→ Délai **9,347 s** (10:30:27.654 − 10:30:18.307), à comparer aux 0,198 s de l'arrêt propre : **47× plus lent**.
Ce délai est légèrement **inférieur** à `electionTimeoutMillis` (10 000 ms) relevé en Q6, ce qui s'explique par
`heartbeatIntervalMillis` (2000 ms) : le compte à rebours de 10 s démarre au **dernier heartbeat réussi**, pas à
l'instant du kill — en moyenne, le kill survient au milieu d'un intervalle de heartbeat déjà entamé, d'où un délai
observé proche de `electionTimeoutMillis − heartbeatIntervalMillis/2 ≈ 9 s`, cohérent avec les 9,35 s mesurés.

### Q23 — quorum (2 nœuds sur 3 arrêtés)

Expérience menée en isolant le **PRIMARY lui-même** (`docker stop mongo1 mongo2`, survivant = mongo3, qui était
PRIMARY) :

| Relevé | `isWritablePrimary` | `myState` | `primary` (dans `hello()`) |
|---|---|---|---|
| Immédiatement après le stop | `false` | `2` (SECONDARY) | `undefined` |
| 15 s plus tard | `false` | `2` (SECONDARY) | `undefined` |

**(a)** Les deux relevés sont ici **identiques** — la rétrogradation du primary a été plus rapide que la
résolution de ma mesure manuelle (probablement sub-seconde : un `docker stop` propre ferme proprement les
connexions TCP, ce que le primary isolé détecte quasi instantanément, contrairement à un `docker kill` qui
nécessiterait d'attendre l'expiration du heartbeat comme en Q21).

**(b)** Écriture : `codeName=NotWritablePrimary, message="not primary"` — refusée. Lecture :
`db.zips.countDocuments({})` → **29471** — toujours acceptée (lecture locale, cf. Q13).

**(c)** Avec 3 nœuds, une majorité = 2 voix. Perdre 1 nœud laisse 2 survivants = encore la majorité → le set reste
opérationnel. Perdre 2 nœuds ne laisse qu'1 survivant = pas la majorité → plus aucune écriture possible. Un set de
**4 nœuds** a besoin de 3 voix pour la majorité ; perdre 2 nœuds ne laisse que 2 survivants = **toujours pas la
majorité** — un 4ᵉ nœud ne protège donc pas mieux contre 2 pannes simultanées.

## R3 remesure — `electionTimeoutMillis` abaissé à 2000 ms

```js
var cfg = rs.conf(); cfg.settings.electionTimeoutMillis = 2000; rs.reconfig(cfg)
```
Nouveau `docker kill mongo1`, watcher relancé :
```
KILL_TIME: 10:50:28.319946200
[10:50:18.570] (+   0.03s) primary = mongo1:27017
[10:50:29.156] (+  10.62s) primary = mongo2:27017
```
Délai = 10:50:29.156 − 10:50:28.320 = **0,837 s** (contre 9,347 s avec le réglage par défaut de 10 000 ms).
Valeur d'origine restaurée immédiatement après la mesure (`electionTimeoutMillis = 10000`). Analyse complète dans
`reponses_jour3.md` (R3).
