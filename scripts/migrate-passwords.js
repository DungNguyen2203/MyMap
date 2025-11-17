// Script: Migrate all plaintext passwords to bcrypt hashed passwords
// Run: node scripts/migrate-passwords.js

require('dotenv').config();
const { MongoClient } = require('mongodb');
const bcrypt = require('bcrypt');

const SALT_ROUNDS = 10;

async function migratePasswords() {
    const client = new MongoClient(process.env.MONGO_URI);
    
    try {
        console.log('🔌 Đang kết nối MongoDB...');
        await client.connect();
        
        const usersDb = client.db('users_identity');
        const usersCollection = usersDb.collection('users');
        
        // Lấy tất cả users
        const users = await usersCollection.find({}).toArray();
        console.log(`📊 Tìm thấy ${users.length} users`);
        
        let migratedCount = 0;
        let skippedCount = 0;
        
        for (const user of users) {
            // Kiểm tra xem password đã được hash chưa (bcrypt hash bắt đầu bằng $2a$, $2b$, $2y$)
            const isAlreadyHashed = /^\$2[aby]\$/.test(user.password);
            
            if (isAlreadyHashed) {
                console.log(`⏭️  Skip user ${user.email} - password đã được hash`);
                skippedCount++;
                continue;
            }
            
            // Hash password plaintext
            const hashedPassword = await bcrypt.hash(user.password, SALT_ROUNDS);
            
            // Cập nhật vào database
            await usersCollection.updateOne(
                { _id: user._id },
                { 
                    $set: { 
                        password: hashedPassword,
                        updatedAt: new Date()
                    } 
                }
            );
            
            console.log(`✅ Đã hash password cho user: ${user.email}`);
            migratedCount++;
        }
        
        console.log('\n🎉 Hoàn thành migration!');
        console.log(`   ✅ Đã migrate: ${migratedCount} users`);
        console.log(`   ⏭️  Đã skip: ${skippedCount} users`);
        
    } catch (error) {
        console.error('❌ Lỗi migration:', error);
        process.exit(1);
    } finally {
        await client.close();
        console.log('🔌 Đã đóng kết nối MongoDB');
    }
}

// Chạy migration
migratePasswords();
