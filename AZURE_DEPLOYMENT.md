# Hướng dẫn Deploy lên Microsoft Azure

## 🚀 Cách 1: Deploy qua Azure Portal (Đơn giản nhất)

### Bước 1: Tạo Azure App Service

1. Đăng nhập vào [Azure Portal](https://portal.azure.com)
2. Tìm kiếm **"App Services"** → Click **"+ Create"**
3. Điền thông tin:
   - **Resource Group**: Tạo mới hoặc chọn có sẵn
   - **Name**: `mymap-app` (hoặc tên khác)
   - **Publish**: `Code`
   - **Runtime stack**: `Node 20 LTS`
   - **Operating System**: `Linux`
   - **Region**: Chọn gần bạn nhất (ví dụ: Southeast Asia)
   - **Pricing Plan**: Chọn **Free F1** hoặc **Basic B1**
4. Click **"Review + Create"** → **"Create"**

### Bước 2: Tạo Azure Database for MongoDB (hoặc dùng MongoDB Atlas)

**Option A: Dùng MongoDB Atlas** (Khuyến nghị - Free tier)
- Đã có sẵn connection string `MONGO_URI`
- Bỏ qua bước này

**Option B: Tạo Azure Cosmos DB (MongoDB API)**
1. Tìm **"Azure Cosmos DB"** → Create
2. Chọn **MongoDB** API
3. Tạo database, lấy connection string

### Bước 3: Tạo Azure Cache for Redis

1. Tìm **"Azure Cache for Redis"**
2. Click **"+ Create"**
3. Điền:
   - **Name**: `mymap-redis`
   - **Pricing tier**: **Basic C0** (250MB - tầm 1.2 USD/tháng) hoặc Free tier nếu có
   - **Region**: Cùng region với App Service
4. Sau khi tạo xong, vào **Access keys** → Copy **Primary connection string**

### Bước 4: Cấu hình Environment Variables

1. Vào **App Service** vừa tạo
2. Sidebar trái → **Configuration** → **Application settings**
3. Click **"+ New application setting"** và thêm:

```
NODE_ENV=production
MONGO_URI=mongodb+srv://user:pass@cluster.mongodb.net/db
SESSION_SECRET=<random-string-at-least-32-chars>
REDIS_URL=rediss://default:<password>@<hostname>:6380
CLOUDINARY_CLOUD_NAME=your_cloud_name
CLOUDINARY_API_KEY=your_api_key
CLOUDINARY_API_SECRET=your_api_secret
GEMINI_API_KEYS=key1,key2,key3
OCRSPACE_API_KEY=your_key
HUGGINGFACE_TOKEN=your_token
OPENROUTER_API_KEY=your_key
WEBSITE_NODE_DEFAULT_VERSION=20-lts
SCM_DO_BUILD_DURING_DEPLOYMENT=true
```

4. Click **"Save"** → **"Continue"**

### Bước 5: Deploy Code lên Azure

**Method A: Deploy từ GitHub (Khuyến nghị)**

1. Trong App Service, vào **Deployment Center**
2. Chọn **"GitHub"** → Authorize và chọn repository `MyMap`
3. Chọn branch `main`
4. Click **"Save"**
5. Azure sẽ tự động deploy mỗi khi bạn push code

**Method B: Deploy bằng Azure CLI**

```bash
# Cài Azure CLI: https://learn.microsoft.com/en-us/cli/azure/install-azure-cli

# Login
az login

# Deploy
az webapp up --name mymap-app --resource-group <your-resource-group> --runtime "NODE:20-lts"
```

**Method C: Deploy bằng VS Code**

1. Cài extension **"Azure App Service"**
2. Sign in to Azure
3. Right-click folder `MyMap` → **"Deploy to Web App"**
4. Chọn App Service vừa tạo

### Bước 6: Kiểm tra Deployment

1. Vào **App Service** → **Overview** → Click **URL**
2. Hoặc truy cập: `https://mymap-app.azurewebsites.net`

---

## 🔧 Troubleshooting

### Nếu gặp lỗi build:

1. Vào **App Service** → **Development Tools** → **Advanced Tools (Kudu)**
2. Click **"Go"** → Vào **Debug console** → **CMD**
3. Chạy thủ công:
```bash
cd site/wwwroot
npm install
cd MindMapBoDoi/project-d10
npm install
npm run build
```

### Xem logs:

```bash
# Azure CLI
az webapp log tail --name mymap-app --resource-group <your-resource-group>
```

Hoặc vào Portal → **App Service** → **Monitoring** → **Log stream**

---

## 💰 Chi phí ước tính (USD/tháng)

- **App Service Free F1**: $0 (giới hạn 60 phút CPU/ngày, 1GB RAM)
- **App Service Basic B1**: ~$13 (1 core, 1.75GB RAM, unlimited)
- **Azure Cache for Redis Basic C0**: ~$1.2 (250MB)
- **MongoDB Atlas Free Tier**: $0 (512MB)

**Tổng**: $0 - $15/tháng tùy plan

---

## 📝 Lưu ý quan trọng

1. **WebSocket cho Socket.IO**: 
   - Azure App Service hỗ trợ WebSocket mặc định
   - Không cần cấu hình thêm

2. **Custom Domain** (nếu muốn):
   - Vào **App Service** → **Custom domains**
   - Thêm domain của bạn

3. **SSL Certificate**:
   - Azure tự động cấp SSL miễn phí cho `*.azurewebsites.net`
   - Với custom domain, dùng **App Service Managed Certificate** (free)

4. **Scaling**:
   - Free tier: Không scale được
   - Basic/Standard: Scale manually
   - Premium: Auto-scaling

---

## 🚀 Các bước sau deploy thành công

1. Test các chức năng:
   - Đăng ký/đăng nhập
   - Upload document
   - Tạo/edit mindmap
   - Chat real-time

2. Monitor performance:
   - Azure Portal → App Service → **Metrics**
   - Xem CPU, Memory, Response time

3. Setup backup (Optional):
   - **App Service** → **Backups**
   - Schedule automatic backups

---

Bạn có Azure account chưa? Tôi có thể hướng dẫn chi tiết hơn bước nào nếu cần!
