// pipelines.js - Jour 4, Partie B1 à B3
// Exécutable via : mongosh -u admin -p ipssi2025 --authenticationDatabase admin citibike < pipelines.js

// --- B1 : fondamentaux ---

// Q12 - Top 5 des stations de départ
print("Q12 - top 5 stations de depart");
printjson(db.trips.aggregate([
  { $group: { _id: "$start station id", nom: { $first: "$start station name" }, n: { $sum: 1 } } },
  { $sort: { n: -1 } },
  { $limit: 5 }
]).toArray());

// Q13 - Répartition par type d'abonnement (nombre + durée moyenne)
print("Q13 - repartition par usertype");
printjson(db.trips.aggregate([
  { $group: { _id: "$usertype", n: { $sum: 1 }, dureeMoyenne: { $avg: "$tripduration" } } },
  { $sort: { n: -1 } }
]).toArray());

// Q14 - Trajets par jour
print("Q14 - trajets par jour");
printjson(db.trips.aggregate([
  { $group: { _id: { $dateTrunc: { date: "$start time", unit: "day" } }, n: { $sum: 1 } } },
  { $sort: { _id: 1 } }
]).toArray());

// Q15 - Trajets par heure de départ (top 5)
print("Q15 - top 5 heures de depart");
printjson(db.trips.aggregate([
  { $group: { _id: { $hour: "$start time" }, n: { $sum: 1 } } },
  { $sort: { n: -1 } },
  { $limit: 5 }
]).toArray());

// Q16 - Distribution des durées
print("Q16 - bucket des durees");
printjson(db.trips.aggregate([
  { $bucket: {
      groupBy: "$tripduration",
      boundaries: [0, 300, 600, 1800, 3600, 1000000],
      default: "autre",
      output: { n: { $sum: 1 } }
  } }
]).toArray());

// Q17 - Boucles (départ == arrivée)
print("Q17 - trajets en boucle");
print(db.trips.countDocuments({ $expr: { $eq: ["$start station id", "$end station id"] } }));

// --- B2 : qualité de données et optimiseur ---

// Q18 - birth year : type string vs int, croisé avec usertype
print("Q18 - birth year par type et usertype");
printjson(db.trips.aggregate([
  { $group: { _id: { type: { $type: "$birth year" }, usertype: "$usertype" }, n: { $sum: 1 } } },
  { $sort: { n: -1 } }
]).toArray());

// Q19 - âge moyen (années numériques uniquement)
print("Q19 - age moyen en 2016");
printjson(db.trips.aggregate([
  { $match: { "birth year": { $type: "number" } } },
  { $group: { _id: null,
      ageMoyen: { $avg: { $subtract: [2016, "$birth year"] } },
      n: { $sum: 1 },
      naissanceMin: { $min: "$birth year" } } }
]).toArray());

// Q20 - valeurs aberrantes
print("Q20 - trajets > 3h et > 24h");
print("plus de 3h :", db.trips.countDocuments({ tripduration: { $gt: 10800 } }));
print("plus de 24h :", db.trips.countDocuments({ tripduration: { $gt: 86400 } }));
printjson(db.trips.find({}, { tripduration: 1, usertype: 1, _id: 0 }).sort({ tripduration: -1 }).limit(3).toArray());

// Q21 - durée moyenne par usertype hors trajets > 3h
print("Q21 - duree moyenne par usertype (hors > 3h)");
printjson(db.trips.aggregate([
  { $match: { tripduration: { $lte: 10800 } } },
  { $group: { _id: "$usertype", n: { $sum: 1 }, dureeMoyenne: { $avg: "$tripduration" } } },
  { $sort: { n: -1 } }
]).toArray());

// Q22 - deux pipelines équivalents, comparés via explain (voir reponses_jour4.md pour le détail explain)
print("Q22 - pipeline A (match puis group)");
printjson(db.trips.aggregate([
  { $match: { usertype: "Subscriber" } },
  { $group: { _id: "$start station id", n: { $sum: 1 } } }
]).toArray().length);
print("Q22 - pipeline B (group puis match)");
printjson(db.trips.aggregate([
  { $group: { _id: { s: "$start station id", u: "$usertype" }, n: { $sum: 1 } } },
  { $match: { "_id.u": "Subscriber" } }
]).toArray().length);

// Q23 - la limite de l'optimiseur : match sur un champ calculé par le group
print("Q23 - stations > 50 departs");
printjson(db.trips.aggregate([
  { $group: { _id: "$start station id", n: { $sum: 1 } } },
  { $match: { n: { $gt: 50 } } }
]).toArray());

// --- B3 : matérialisation et jointure ---

// Q24 - construction de la collection stations via $merge
print("Q24 - construction de stations");
db.trips.aggregate([
  { $group: {
      _id: "$start station id",
      nom: { $first: "$start station name" },
      position: { $first: "$start station location" },
      departs: { $sum: 1 } } },
  { $merge: { into: "stations", whenMatched: "replace" } }
]);
print("nombre de stations :", db.stations.countDocuments({}));
printjson(db.stations.find({}).sort({ departs: -1 }).limit(3).toArray());

// Q26 - top 5 des stations d'arrivée avec jointure sur stations
print("Q26 - top 5 stations d'arrivee (avec nom via $lookup)");
printjson(db.trips.aggregate([
  { $group: { _id: "$end station id", n: { $sum: 1 } } },
  { $sort: { n: -1 } },
  { $limit: 5 },
  { $lookup: { from: "stations", localField: "_id", foreignField: "_id", as: "info" } },
  { $unwind: "$info" },
  { $project: { _id: 1, nom: "$info.nom", n: 1 } }
]).toArray());
