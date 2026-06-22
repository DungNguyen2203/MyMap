/**
 * File: migrate-bcrypt-passwords.js
 *
 * Script chạy 1 lần để hash toàn bộ mật khẩu plain text hiện có trong DB
 * sang bcrypt hash.
 *
 * CÁCH SỬ DỤNG:
 *   node migrate-bcrypt-passwords.js
 *
 * QUAN TRỌNG: Chỉ chạy script này 1 lần duy nhất.
 * Sau khi chạy, các mật khẩu đã được hash và không thể đảo ngược.
 */

require('dotenv').config();
const { MongoClient } = require('mongodb');
const bcrypt = require('bcrypt');

const SALT_ROUNDS = 10;
const BCRYPT_PREFIX = '$2b$'; // Tiền tố chuẩn của bcrypt hash

async function migratePasswords() {
    const uri = process.env.MONGO_URI;
    if (!uri) {
        console.error('❌ Lỗi: MONGO_URI chưa được thiết lập trong .env');
        process.exit(1);
    }

    const client = new MongoClient(uri);

    try {
        await client.connect();
        console.log('✅ Đã kết nối MongoDB');

        const usersDb = client.db('users_identity');
        const usersCollection = usersDb.collection('users');

        // Lấy tất cả user
        const users = await usersCollection.find({}).toArray();
        console.log(`📋 Tìm thấy ${users.length} user cần kiểm tra...`);

        let migratedCount = 0;
        let skippedCount = 0;
        let errorCount = 0;

        for (const user of users) {
            try {
                // Bỏ qua nếu mật khẩu đã là bcrypt hash
                if (user.password && user.password.startsWith(BCRYPT_PREFIX)) {
                    skippedCount++;
                    continue;
                }

                // Hash mật khẩu plain text
                const hashedPassword = await bcrypt.hash(user.password, SALT_ROUNDS);

                await usersCollection.updateOne(
                    { _id: user._id },
                    {
                        $set: {
                            password: hashedPassword,
                            updatedAt: new Date()
                        }
                    }
                );

                console.log(`   ✅ Đã hash mật khẩu cho user: ${user.email} (${user.username})`);
                migratedCount++;

            } catch (userErr) {
                console.error(`   ❌ Lỗi khi xử lý user ${user.email}:`, userErr.message);
                errorCount++;
            }
        }

        console.log('\n========================================');
        console.log('📊 KẾT QUẢ MIGRATION:');
        console.log(`   ✅ Đã migrate: ${migratedCount} user`);
        console.log(`   ⏭️  Đã bỏ qua (đã hash): ${skippedCount} user`);
        console.log(`   ❌ Lỗi: ${errorCount} user`);
        console.log('========================================');

        if (migratedCount > 0) {
            console.log('\n✅ Migration hoàn tất! Mật khẩu đã được bảo vệ bằng bcrypt.');
        }

    } catch (err) {
        console.error('❌ Lỗi kết nối hoặc migration:', err);
    } finally {
        await client.close();
        console.log('🔌 Đã đóng kết nối MongoDB');
    }
}

migratePasswords();
