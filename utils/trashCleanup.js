// File: utils/trashCleanup.js
// Cron job tự động xóa vĩnh viễn các mindmap đã ở thùng rác hơn 30 ngày

const TRASH_RETENTION_DAYS = 30;
const RUN_INTERVAL_MS = 24 * 60 * 60 * 1000; // Chạy mỗi 24 giờ

/**
 * Quét toàn bộ các collection trong database mindmaps và xóa vĩnh viễn
 * những document có deleted = true và deletedAt quá 30 ngày.
 *
 * @param {import('mongodb').Db} mindmapsDb - MongoDB database instance
 */
async function cleanupExpiredTrash(mindmapsDb) {
    try {
        const cutoffDate = new Date(Date.now() - TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000);
        console.log(`🗑️  [TrashCleanup] Đang quét thùng rác hết hạn (trước ${cutoffDate.toISOString()})...`);

        // Lấy danh sách tất cả collection trong mindmapsDb (mỗi collection = 1 user)
        const collections = await mindmapsDb.listCollections().toArray();

        let totalDeleted = 0;

        for (const collInfo of collections) {
            // Bỏ qua các collection hệ thống
            if (collInfo.name.startsWith('system.')) continue;

            const collection = mindmapsDb.collection(collInfo.name);

            // Xóa vĩnh viễn các mindmap đã bị soft-delete và quá 30 ngày
            const result = await collection.deleteMany({
                deleted: true,
                deletedAt: { $lt: cutoffDate }
            });

            if (result.deletedCount > 0) {
                console.log(`   ✅ [TrashCleanup] Collection "${collInfo.name}": đã xóa ${result.deletedCount} mindmap hết hạn.`);
                totalDeleted += result.deletedCount;
            }
        }

        if (totalDeleted === 0) {
            console.log('   ℹ️  [TrashCleanup] Không có mindmap nào cần xóa.');
        } else {
            console.log(`🗑️  [TrashCleanup] Hoàn tất: đã xóa vĩnh viễn ${totalDeleted} mindmap.`);
        }

    } catch (err) {
        console.error('❌ [TrashCleanup] Lỗi khi dọn thùng rác:', err);
    }
}

/**
 * Khởi động cron job tự động dọn thùng rác.
 * Chạy ngay một lần khi server khởi động, sau đó lặp mỗi 24 giờ.
 *
 * @param {import('mongodb').Db} mindmapsDb
 */
function startTrashCleanupJob(mindmapsDb) {
    console.log(`🗑️  [TrashCleanup] Khởi động cron job tự động dọn thùng rác (mỗi 24h, giữ ${TRASH_RETENTION_DAYS} ngày).`);

    // Chạy lần đầu sau 10 giây kể từ khi server khởi động (để server kịp init xong)
    setTimeout(async () => {
        await cleanupExpiredTrash(mindmapsDb);

        // Sau đó lặp mỗi 24 giờ
        const interval = setInterval(() => cleanupExpiredTrash(mindmapsDb), RUN_INTERVAL_MS);

        // Không giữ process sống nếu app tắt
        interval.unref();
    }, 10 * 1000);
}

module.exports = { startTrashCleanupJob, cleanupExpiredTrash };
