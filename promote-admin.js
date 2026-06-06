// File: promote-admin.js
require('dotenv').config();
const { MongoClient } = require('mongodb');

const uri = process.env.MONGO_URI;
if (!uri) {
  console.error("❌ Lỗi: MONGO_URI chưa được thiết lập trong file .env");
  process.exit(1);
}

const emailArg = process.argv[2];

async function run() {
  const client = new MongoClient(uri);
  try {
    await client.connect();
    const db = client.db('users_identity');
    const usersCollection = db.collection('users');

    if (!emailArg) {
      console.log("\n=======================================================");
      console.log("🔑 TRÌNH QUẢN LÝ TÀI KHOẢN ADMIN (MINDTREE)");
      console.log("=======================================================\n");
      console.log("Cú pháp nâng cấp tài khoản:");
      console.log("  node promote-admin.js <email_nguoi_dung>\n");
      console.log("Ví dụ: node promote-admin.js user@gmail.com\n");
      
      console.log("Danh sách người dùng hiện tại trong hệ thống:");
      const users = await usersCollection.find({}).project({ username: 1, email: 1, role: 1, status: 1 }).toArray();
      if (users.length === 0) {
        console.log("  (Chưa có người dùng nào đăng ký. Hãy tạo tài khoản trước!)");
      } else {
        console.table(users.map(u => ({
          'Tên đăng nhập': u.username,
          'Email': u.email,
          'Quyền hạn': u.role || 'student',
          'Trạng thái': u.status || 'active'
        })));
      }
      return;
    }

    const email = emailArg.trim().toLowerCase();
    const user = await usersCollection.findOne({ email });

    if (!user) {
      console.error(`\n❌ Không tìm thấy người dùng có email: ${emailArg}`);
      console.log("Vui lòng đăng ký tài khoản trên giao diện web trước, sau đó chạy lại script này.");
      return;
    }

    if (user.role === 'admin') {
      console.log(`\nℹ️ Tài khoản ${email} đã là ADMIN từ trước.`);
      return;
    }

    const result = await usersCollection.updateOne(
      { _id: user._id },
      { $set: { role: 'admin', updatedAt: new Date() } }
    );

    if (result.modifiedCount > 0) {
      console.log(`\n🎉 THÀNH CÔNG: Đã nâng cấp tài khoản "${user.username}" (${email}) thành ADMIN!`);
      console.log("Bây giờ bạn có thể đăng nhập vào tài khoản này và truy cập vào trang Admin Panel tại /admin/dashboard.");
    } else {
      console.log("\n⚠️ Không có thay đổi nào được thực hiện.");
    }

  } catch (error) {
    console.error("❌ Đã xảy ra lỗi:", error);
  } finally {
    await client.close();
  }
}

run();
