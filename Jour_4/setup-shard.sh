#!/bin/sh
# setup-shard.sh - monte le cluster shardé (4 conteneurs) et le prépare pour le TP Jour 4, Partie A.
set -e

echo "1) Démarrage des 4 conteneurs (cfg1, shardA, shardB, mongos)"
docker compose -f docker-compose.shard.yml up -d
sleep 15

echo "2) Initialisation du replica set du config server (cfgRS)"
docker exec cfg1 mongosh --quiet --eval "rs.initiate({_id:'cfgRS',configsvr:true,members:[{_id:0,host:'cfg1:27017'}]})"

echo "3) Initialisation des replica sets de chaque shard (shardA, shardB)"
docker exec shardA mongosh --quiet --eval "rs.initiate({_id:'shardA',members:[{_id:0,host:'shardA:27017'}]})"
docker exec shardB mongosh --quiet --eval "rs.initiate({_id:'shardB',members:[{_id:0,host:'shardB:27017'}]})"
sleep 15

echo "4) Enregistrement des shards auprès du routeur mongos"
docker exec mongos mongosh --quiet --eval "sh.addShard('shardA/shardA:27017'); sh.addShard('shardB/shardB:27017');"

echo "5) Réduction de la taille des chunks à 1 Mo (au lieu de 128 Mo par défaut)"
docker exec mongos mongosh --quiet config --eval "db.settings.updateOne({_id:'chunksize'},{\$set:{value:1}},{upsert:true})"

echo "Cluster shardé prêt."
