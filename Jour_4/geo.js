// geo.js - Jour 4, Partie B4 (index géospatial 2dsphere)
// Exécutable via : mongosh -u admin -p ipssi2025 --authenticationDatabase admin citibike < geo.js
// Point de référence : Times Square [-73.9855, 40.7580]

// Q27 - $near sans index : doit lever une erreur
print("Q27 - $near sans index (erreur attendue)");
try {
  db.trips.find({ "start station location": { $near: {
    $geometry: { type: "Point", coordinates: [-73.9855, 40.7580] }, $maxDistance: 500 } } }).toArray();
} catch (e) {
  print("ERREUR : " + e.message);
}

// Q28 - création de l'index 2dsphere puis $near
print("Q28 - creation index 2dsphere sur start station location");
db.trips.createIndex({ "start station location": "2dsphere" });
var q28 = db.trips.find({ "start station location": { $near: {
  $geometry: { type: "Point", coordinates: [-73.9855, 40.7580] }, $maxDistance: 500 } } }, { "start station name": 1, _id: 0 }).toArray();
print("nombre de resultats :", q28.length);
print("10 premiers noms (ordre $near, doublons inclus - $near trie les documents, pas les stations)");
printjson(q28.slice(0, 10));

// Q29 - countDocuments avec $near : erreur, puis $geoWithin + $centerSphere
print("Q29 - countDocuments avec $near (erreur attendue)");
try {
  db.trips.countDocuments({ "start station location": { $near: {
    $geometry: { type: "Point", coordinates: [-73.9855, 40.7580] }, $maxDistance: 500 } } });
} catch (e) {
  print("ERREUR : " + e.message);
}
var rad500 = 0.5 / 6378.1;
var rad1000 = 1 / 6378.1;
print("trajets a moins de 500 m :", db.trips.countDocuments({ "start station location": {
  $geoWithin: { $centerSphere: [[-73.9855, 40.7580], rad500] } } }));
print("trajets a moins de 1000 m :", db.trips.countDocuments({ "start station location": {
  $geoWithin: { $centerSphere: [[-73.9855, 40.7580], rad1000] } } }));

// Q30 - $geoNear sur la collection stations
print("Q30 - $geoNear sur stations, moins de 1 km de Times Square");
db.stations.createIndex({ position: "2dsphere" });
var q30 = db.stations.aggregate([
  { $geoNear: {
      near: { type: "Point", coordinates: [-73.9855, 40.7580] },
      distanceField: "distanceM",
      maxDistance: 1000,
      spherical: true } },
  { $project: { _id: 1, nom: 1, distanceM: { $round: ["$distanceM", 0] }, departs: 1 } },
  { $sort: { distanceM: 1 } }
]).toArray();
print("nombre de stations :", q30.length);
printjson(q30);
