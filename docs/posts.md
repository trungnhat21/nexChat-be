# Bài viết và media local

## Luồng

- Login trả access token; FE giữ trong bộ nhớ và gửi Bearer token cho API. Khi reload hoặc token hết hạn, FE khôi phục bằng refresh cookie HttpOnly.
- Home lấy bài từ API, không khởi tạo bài viết hoặc bình luận mẫu. Tác giả do BE lấy từ phiên đăng nhập.
- FE gửi multipart/form-data cho tạo/sửa bài. BE kiểm tra nội dung, MIME và chữ ký file rồi upload vào MinIO; MySQL lưu bài và metadata/key media trong các bảng hiện có.
- Bucket giữ private. API trả URL GET có chữ ký, hiệu lực 1 giờ, để hiển thị ảnh/video. Nếu liên kết hết hạn, chọn tải lại bảng tin.
- Chỉ tác giả được sửa/xóa. Khi sửa, FE gửi ID của media cần giữ; media bị bỏ được dọn khỏi MinIO sau khi DB commit. Xóa bài dùng deleted_at và dọn attachment.
- Bảng tin gồm bài công khai, bài của chính mình và bài giới hạn bạn bè của các quan hệ accepted. Tìm kiếm và phân trang thực hiện ở BE.

Profile dùng authorId để lọc tác giả ngay tại BE. /profile lấy ID từ phiên đăng nhập; /profile/:userId lấy ID trên URL. Phản hồi có author (thông tin hiển thị) và total (số bài người xem được phép xem). Phân trang luôn giữ authorId.

## Cấu hình

Dùng các biến đã có trong BE .env:

| Biến | Ý nghĩa |
| --- | --- |
| S3_ENDPOINT | API MinIO, ví dụ http://localhost:9000; 9001 là console |
| S3_BUCKET | Bucket hiện có: nex-images |
| S3_ACCESS_KEY_ID | Access key của MinIO, chỉ đặt ở BE |
| S3_SECRET_ACCESS_KEY | Secret key của MinIO, chỉ đặt ở BE |
| S3_REGION | Ví dụ us-east-1 |

Không cần đổi bucket thành public, không cần migration hoặc cấu hình CORS upload vì file đi qua BE. Trình duyệt cần truy cập được địa chỉ S3_ENDPOINT.

Khởi động MinIO, MySQL, Redis và BE/FE theo luồng phát triển hiện có. Đăng nhập rồi mở /home. Khi chưa có bài, bảng tin hiển thị trạng thái trống.

## API

Tất cả endpoint yêu cầu Authorization: Bearer <accessToken>.

| Method | URL | Chức năng |
| --- | --- | --- |
| GET | /api/posts?search=...&cursor=...&authorId=... | Tối đa 20 bài, nextCursor để tải tiếp |
| POST | /api/posts | Tạo bài; multipart |
| PATCH | /api/posts/:id | Sửa bài; multipart |
| DELETE | /api/posts/:id | Xóa bài của mình |

Các trường multipart:

- content: nội dung tối đa 5.000 ký tự; có thể trống nếu có media.
- privacy: public, friends hoặc private.
- keepMediaIds: chuỗi JSON các ID media cần giữ, ví dụ ["12","13"]; tạo mới gửi [].
- media: file mới, có thể lặp nhiều trường cùng tên.

Khi PATCH, gửi đầy đủ content, privacy và keepMediaIds để tránh vô tình xóa media hoặc đổi quyền riêng tư. Media cần giữ phải thuộc bài đang sửa.

Giới hạn: 5 file/bài, 25 MiB/file, tổng 50 MiB kể cả file giữ lại. Hỗ trợ JPEG, PNG, GIF, WebP, MP4, WebM. Chưa xử lý chuyển mã/nén video.

## Kiểm tra

Build BE trước:

    npm run build
    node --test tests/posts.test.mjs

Bật kiểm tra MySQL và MinIO thật trong PowerShell, dùng .env local hiện có:

    $env:POSTS_DB_TESTS = "1"
    $env:POSTS_MINIO_TESTS = "1"
    node --test tests/posts.test.mjs

Test MySQL tạo fixture trong transaction rồi rollback; không sửa bài/tài khoản đang có. Test MinIO tạo key ngẫu nhiên riêng rồi xóa key đó.

FE:

    npm run build
    npx eslint src/page/home src/axios src/component/type/home.ts src/component/type/post.ts src/component/type/auth.ts

## Phạm vi và giới hạn

- Bài viết của home và profile, media liên quan và danh tính tài khoản dùng dữ liệu thật. Story, widget xu hướng/gợi ý và các trường hồ sơ chưa có API vẫn nằm ngoài phạm vi này.
- Thích, bình luận và lưu bài hiện thông báo chưa hỗ trợ, không thêm tương tác giả vào số liệu thật.
- Transaction DB và MinIO không thể commit nguyên tử. Upload mới được dọn nếu DB thất bại. Nếu MinIO mất kết nối lúc dọn file, bài vẫn được cập nhật/xóa trong DB và BE ghi log "Media cleanup pending" kèm key để quản trị viên dọn lại. Chưa có worker retry nền.

## Ảnh đại diện và ảnh bìa

- PATCH /api/profile/images/avatar hoặc /api/profile/images/cover, Bearer token, multipart có đúng một trường file tên image.
- Chỉ cập nhật tài khoản của phiên đăng nhập; không nhận userId từ client.
- Nhận JPEG, PNG, GIF, WebP tối đa 10 MiB. File lưu dưới profiles/<userId>/ trong bucket hiện có.
- DB lưu object key, không lưu URL có chữ ký. Avatar được lưu đồng bộ ở users.avatar và profiles.avatar_url; cover lưu ở profiles.cover_url. API ký URL khi đọc để ảnh dùng được sau reload.
- Đổi ảnh thực hiện ngay khi chọn file; chỉ cập nhật giao diện sau khi BE lưu thành công. Ảnh cũ được dọn sau DB commit; upload mới được dọn nếu DB thất bại.
- DB local đã được bổ sung profiles.cover_url. Với DB khác chưa có cột này, áp dụng một lần prisma/patches/20261022_profile_cover.sql rồi chạy npx prisma generate. Không reset database.
- Các trường văn bản trong hộp chỉnh sửa hồ sơ vẫn là bản xem thử; endpoint này chỉ lưu ảnh.

Kiểm tra upload bằng MySQL/MinIO thật, dùng fixture rollback và file tạm tự dọn:

    npm run build
    $env:PROFILE_IMAGE_INTEGRATION = "1"
    node --test tests/profile-images.test.mjs
