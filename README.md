# NexChat Backend

Backend NestJS sử dụng Prisma và MariaDB.

## Chạy project

```bash
npm install
npx prisma generate
npm run start:dev
```

Production:

```bash
npx prisma generate
npm run build
npm run start:prod
```

Lệnh `npm run build` sử dụng Nest CLI và xuất application vào `dist/`.
Production process được quản lý bằng `ecosystem.config.cjs` và chạy entry point
`dist/main.js`.

Jenkins cài dependency bằng `npm ci`, generate Prisma Client, build NestJS và
reload process PM2 từ ecosystem file. Pipeline không chạy `prisma db pull` nên
không ghi đè Prisma schema trong lúc deploy.

Các biến môi trường và Prisma schema được giữ nguyên so với backend Express trước đó.
