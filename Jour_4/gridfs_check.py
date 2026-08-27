"""gridfs_check.py - Bonus B1, Jour 4
Retélécharge le fichier stocké dans GridFS (db "medias") et vérifie que sa taille
correspond exactement à l'original (/tmp/trips.json à l'intérieur du conteneur, 7112796 octets).
Usage : python gridfs_check.py
"""
import gridfs
from pymongo import MongoClient

client = MongoClient(
    "mongodb://admin:ipssi2025@localhost:27017/",
    authSource="admin",
)
db = client["medias"]
fs = gridfs.GridFS(db)

fichier = fs.find_one({"filename": "/tmp/trips.json"})
print("longueur en base :", fichier.length)
print("taille de chunk :", fichier.chunk_size)
print("date d'upload :", fichier.upload_date)

contenu = fichier.read()
print("taille réellement retéléchargée :", len(contenu))
print("correspondance exacte :", len(contenu) == fichier.length)
