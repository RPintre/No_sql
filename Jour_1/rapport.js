// rapport.js — TP Jour 1, Partie 5
// Usage : docker exec -i mongo-ipssi mongosh -u admin -p ipssi2025 --authenticationDatabase admin nyc < rapport.js

print("========================================");
print(" RAPPORT — collection nyc.restaurants");
print("========================================");

// 1. Nombre total de restaurants
var total = db.restaurants.countDocuments({});
print("\n1. Nombre total de restaurants : " + total);

// 2. Top 5 des cuisines les plus fréquentes
var cuisines = db.restaurants.distinct("cuisine");
var cuisineCounts = [];
cuisines.forEach(function (c) {
  var n = db.restaurants.countDocuments({ cuisine: c });
  cuisineCounts.push({ cuisine: c, count: n });
});
cuisineCounts.sort(function (a, b) {
  return b.count - a.count;
});

print("\n2. Top 5 des cuisines les plus fréquentes :");
for (var i = 0; i < 5 && i < cuisineCounts.length; i++) {
  print("   " + (i + 1) + ". " + cuisineCounts[i].cuisine + " : " + cuisineCounts[i].count);
}

// 3. Nombre de restaurants par arrondissement
var boroughs = db.restaurants.distinct("borough");
print("\n3. Nombre de restaurants par arrondissement :");
boroughs.forEach(function (b) {
  var n = db.restaurants.countDocuments({ borough: b });
  print("   " + b + " : " + n);
});

print("\n========================================");
print(" Fin du rapport");
print("========================================");
