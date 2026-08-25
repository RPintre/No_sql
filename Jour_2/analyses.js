// analyses.js — TP Jour 2, Partie 3
// Usage : docker exec -i mongo-ipssi mongosh -u admin -p ipssi2025 --authenticationDatabase admin mflix < analyses.js

function h(label) { print("\n===== " + label + " ====="); }

// Q11 - Top 5 des genres par nombre de films
h("Q11 - Top 5 genres");
db.movies.aggregate([
  { $unwind: "$genres" },
  { $group: { _id: "$genres", count: { $sum: 1 } } },
  { $sort: { count: -1 } },
  { $limit: 5 }
]).forEach(printjson);

// Q12 - Nombre de films par decennie (top 3)
h("Q12 - Top 3 decennies");
db.movies.aggregate([
  { $match: { year: { $type: "int" } } },
  { $project: { decade: { $subtract: ["$year", { $mod: ["$year", 10] }] } } },
  { $group: { _id: "$decade", count: { $sum: 1 } } },
  { $sort: { count: -1 } },
  { $limit: 3 }
]).forEach(printjson);

// Q13 - Note IMDB moyenne des films Drama
h("Q13 - Note moyenne Drama");
db.movies.aggregate([
  { $match: { genres: "Drama", "imdb.rating": { $type: "double" } } },
  { $group: { _id: null, moyenne: { $avg: "$imdb.rating" }, n: { $sum: 1 } } },
  { $project: { _id: 0, moyenne: { $round: ["$moyenne", 4] }, n: 1 } }
]).forEach(printjson);

// Q14 - Top 3 realisateurs par nombre de films
h("Q14 - Top 3 realisateurs");
db.movies.aggregate([
  { $unwind: "$directors" },
  { $group: { _id: "$directors", count: { $sum: 1 } } },
  { $sort: { count: -1 } },
  { $limit: 3 }
]).forEach(printjson);

// Q15 - Top 5 des films les plus commentes ($lookup inverse depuis comments)
h("Q15 - Top 5 films les plus commentes");
db.comments.aggregate([
  { $group: { _id: "$movie_id", count: { $sum: 1 } } },
  { $sort: { count: -1 } },
  { $limit: 5 },
  { $lookup: { from: "movies", localField: "_id", foreignField: "_id", as: "movie" } },
  { $unwind: "$movie" },
  { $project: { _id: 0, title: "$movie.title", count: 1 } }
]).forEach(printjson);

print("\nDONE");
