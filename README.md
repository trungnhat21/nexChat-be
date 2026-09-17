# NexChat Backend

Backend NestJS sử dụng Prisma và MariaDB.

## Chạy project

```bash
npm install
npx prisma generate
npm run dev
```

Production:

```bash
npx prisma generate
npm run build
npm run prod
```

Lệnh `npm run build` sử dụng Nest CLI và xuất application vào `dist/`.
Production process được quản lý bằng `ecosystem.config.cjs` và chạy entry point
`dist/main.js`.

Jenkins cài dependency bằng `npm ci`, generate Prisma Client, build NestJS và
reload process PM2 từ ecosystem file. Pipeline không chạy `prisma db pull` nên
không ghi đè Prisma schema trong lúc deploy.

Các biến môi trường và Prisma schema được giữ nguyên so với backend Express trước đó.

## Neo4j

Khai báo các biến sau để bật kết nối Neo4j:

```env
NEO4J_URI=neo4j://localhost:7687
NEO4J_USERNAME=neo4j
NEO4J_PASSWORD=your-password
NEO4J_DATABASE=neo4j
```

Khi được cấu hình, backend kiểm tra kết nối Neo4j trong quá trình startup và đóng
driver khi application shutdown. Nếu không có biến `NEO4J_*`, integration được
tắt và các API hiện tại vẫn hoạt động bình thường.

`UsersService` sử dụng MariaDB làm source of truth và đồng bộ node `User` sang
Neo4j khi create, update hoặc soft-delete. Các thao tác đọc vẫn trả dữ liệu từ
MariaDB để giữ nguyên API contract, đồng thời đối chiếu Neo4j và ghi log khi phát
hiện data drift. Hai database không dùng chung một distributed transaction; nếu
Neo4j lỗi sau khi MariaDB đã thành công, lỗi được log và request giữ behavior cũ.
