from pymongo import MongoClient, UpdateOne

client = MongoClient("mongodb://admin:ipssi2025@localhost:27017/?authSource=admin")
db = client["mflix"]


def q16_reconciliation():
    real_counts = {}
    for doc in db.comments.aggregate([
        {"$group": {"_id": "$movie_id", "count": {"$sum": 1}}}
    ]):
        real_counts[doc["_id"]] = doc["count"]

    mismatched = 0
    total_checked = 0
    mismatched_with_field = 0
    with_field = 0
    for movie in db.movies.find({}, {"num_mflix_comments": 1}):
        real = real_counts.get(movie["_id"], 0)
        has_field = "num_mflix_comments" in movie
        stored = movie.get("num_mflix_comments", 0)
        total_checked += 1
        if stored != real:
            mismatched += 1
        if has_field:
            with_field += 1
            if stored != real:
                mismatched_with_field += 1

    print(f"Q16 total_checked={total_checked}")
    print(f"Q16 mismatched={mismatched}")
    print(f"Q16 with_field={with_field}")
    print(f"Q16 mismatched_with_field={mismatched_with_field}")
    print(f"Q16 pct_mismatched_with_field={mismatched_with_field / with_field * 100:.2f}")
    return real_counts


def q17_fix_counters(real_counts):
    ops = []
    for movie in db.movies.find({}, {"num_mflix_comments": 1}):
        real = real_counts.get(movie["_id"], 0)
        if movie.get("num_mflix_comments", 0) != real:
            ops.append(UpdateOne({"_id": movie["_id"]}, {"$set": {"num_mflix_comments": real}}))

    if ops:
        result = db.movies.bulk_write(ops)
        print(f"Q17 matchedCount={result.matched_count}")
        print(f"Q17 modifiedCount={result.modified_count}")
    else:
        print("Q17 modifiedCount=0 (rien a corriger)")


def q16_reverify():
    real_counts = {}
    for doc in db.comments.aggregate([
        {"$group": {"_id": "$movie_id", "count": {"$sum": 1}}}
    ]):
        real_counts[doc["_id"]] = doc["count"]

    mismatched = 0
    for movie in db.movies.find({}, {"num_mflix_comments": 1}):
        stored = movie.get("num_mflix_comments", 0)
        real = real_counts.get(movie["_id"], 0)
        if stored != real:
            mismatched += 1
    print(f"Q16_reverify mismatched={mismatched}")


def q18_subset_pattern():
    top10 = list(db.comments.aggregate([
        {"$group": {"_id": "$movie_id", "count": {"$sum": 1}}},
        {"$sort": {"count": -1}},
        {"$limit": 10}
    ]))

    for entry in top10:
        movie_id = entry["_id"]
        recent = list(db.comments.find(
            {"movie_id": movie_id},
            {"name": 1, "text": 1, "date": 1, "_id": 0}
        ).sort("date", -1).limit(3))
        db.movies.update_one({"_id": movie_id}, {"$set": {"recent_comments": recent}})

    print(f"Q18 movies_updated={len(top10)}")
    check = db.movies.find_one({"_id": top10[0]["_id"]}, {"title": 1, "recent_comments": 1})
    print(f"Q18 check_title={check['title']}")
    print(f"Q18 check_recent_comments_len={len(check['recent_comments'])}")
    for c in check["recent_comments"]:
        print(f"Q18   - {c['name']} | {c['date']} | {c['text'][:60]}")


if __name__ == "__main__":
    counts = q16_reconciliation()
    q17_fix_counters(counts)
    q16_reverify()
    q18_subset_pattern()
