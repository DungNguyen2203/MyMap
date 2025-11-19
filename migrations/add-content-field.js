const { MongoClient, ObjectId } = require('mongodb');
require('dotenv').config();

async function migrate() {
  const client = new MongoClient(process.env.MONGO_URI);
  
  try {
    await client.connect();
    console.log('🔌 Connected to MongoDB');

    const mindmapsDb = client.db('mindmaps');
    const collections = await mindmapsDb.listCollections().toArray();

    for (const collectionInfo of collections) {
      const collectionName = collectionInfo.name;
      const collection = mindmapsDb.collection(collectionName);

      // Update documents without content field
      const result = await collection.updateMany(
        { content: { $exists: false } },
        { $set: { content: '' } }
      );

      console.log(`✅ Updated ${result.modifiedCount} documents in collection ${collectionName}`);
    }

    console.log('🎉 Migration completed');
  } catch (error) {
    console.error('❌ Migration error:', error);
  } finally {
    await client.close();
  }
}

migrate();
