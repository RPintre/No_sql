# Réponses — TP Jour 1 — Introduction au NoSQL & MongoDB

## Partie 0 — Mise en place

```bash
docker compose up -d
docker compose ps

docker cp primer-dataset.json mongo-ipssi:/tmp/primer-dataset.json
docker exec mongo-ipssi mongoimport \
  --username admin --password ipssi2025 --authenticationDatabase admin \
  --db nyc --collection restaurants --drop --file /tmp/primer-dataset.json
```

```js
use nyc
db.restaurants.countDocuments({})
```
→ **25359**, conforme au point de contrôle P0.
