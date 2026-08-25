// transaction.js — Partie 5, Q19
// Usage : docker exec -i mongo-rs mongosh --port 27017 mflix < transaction.js

function h(label) { print("\n===== " + label + " ====="); }

// On choisit un commentaire dont le movie_id reference un film qui existe reellement
// (9224 commentaires sont orphelins, cf. Q2 : on evite volontairement ce cas ici).
var validMovieIds = db.movies.distinct("_id", { num_mflix_comments: { $gt: 3 } });
var target = db.comments.findOne({ movie_id: { $in: validMovieIds } });
var movieBefore = db.movies.findOne({ _id: target.movie_id }, { title: 1, num_mflix_comments: 1 });

h("Q19_etat_avant");
print("comment_id=" + target._id);
print("movie_title=" + movieBefore.title);
print("num_mflix_comments_avant=" + movieBefore.num_mflix_comments);
print("comments_count_avant=" + db.comments.countDocuments({ movie_id: target.movie_id }));

// ---------- Scenario 1 : transaction commitee (succes) ----------
h("Q19_scenario_commit");
var session = db.getMongo().startSession();
var sessionDb = session.getDatabase("mflix");
session.startTransaction();
try {
  sessionDb.comments.deleteOne({ _id: target._id });
  sessionDb.movies.updateOne(
    { _id: target.movie_id },
    { $inc: { num_mflix_comments: -1 } }
  );
  session.commitTransaction();
  print("commit=ok");
} catch (e) {
  session.abortTransaction();
  print("commit=echec, transaction annulee: " + e);
}
session.endSession();

var movieAfterCommit = db.movies.findOne({ _id: target.movie_id }, { num_mflix_comments: 1 });
print("num_mflix_comments_apres_commit=" + movieAfterCommit.num_mflix_comments);
print("comments_count_apres_commit=" + db.comments.countDocuments({ movie_id: target.movie_id }));

// ---------- Scenario 2 : transaction avortee (echec volontaire au milieu) ----------
h("Q19_scenario_abort");
var otherMovieIds = validMovieIds.filter(function (id) { return id.toString() !== target.movie_id.toString(); });
var target2 = db.comments.findOne({ movie_id: { $in: otherMovieIds } });
var movieBefore2 = db.movies.findOne({ _id: target2.movie_id }, { title: 1, num_mflix_comments: 1 });
print("movie2_title=" + movieBefore2.title);
print("comment2_id=" + target2._id);
print("num_mflix_comments_avant_abort=" + movieBefore2.num_mflix_comments);
print("comments_count_avant_abort=" + db.comments.countDocuments({ movie_id: target2.movie_id }));

var session2 = db.getMongo().startSession();
var sessionDb2 = session2.getDatabase("mflix");
session2.startTransaction();
try {
  sessionDb2.comments.deleteOne({ _id: target2._id });
  sessionDb2.movies.updateOne(
    { _id: target2.movie_id },
    { $inc: { num_mflix_comments: -1 } }
  );
  // Echec volontaire simule au milieu de la transaction (ex: contrainte metier violee)
  throw new Error("echec metier simule avant commit");
} catch (e) {
  session2.abortTransaction();
  print("abort_declenche=oui, raison=" + e.message);
}
session2.endSession();

var movieAfterAbort = db.movies.findOne({ _id: target2.movie_id }, { num_mflix_comments: 1 });
print("num_mflix_comments_apres_abort=" + movieAfterAbort.num_mflix_comments);
print("comments_count_apres_abort=" + db.comments.countDocuments({ movie_id: target2.movie_id }));
print("comment2_existe_toujours=" + (db.comments.countDocuments({ _id: target2._id }) === 1));

print("\nDONE_Q19");
