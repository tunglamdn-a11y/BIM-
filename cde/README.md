# CDE – Môi trường dữ liệu chung quản lý dự án BIM

Ứng dụng web CDE (Common Data Environment) quản lý thông tin dự án theo **ISO 19650**.
Không cần cài thư viện: chỉ cần **Node.js ≥ 18**.

## Chạy nhanh

```bash
cd cde
node server.js --demo     # lần đầu: tạo dữ liệu mẫu
# mở http://localhost:3000
```

- Quản trị: `admin` / `admin123` (đặt khác qua biến `CDE_ADMIN_PASSWORD` trước lần chạy đầu; nên đổi mật khẩu ngay).
- Tài khoản mẫu (mật khẩu `demo123`): `pm` (Quản lý thông tin – CDT), `kt.lead` (Trưởng nhóm – KTA), `kt` (Thành viên – KTA), `kc.lead` (Trưởng nhóm – KCB), `xem` (Chỉ xem – GSA).

Biến môi trường: `PORT` (mặc định 3000), `CDE_DATA` (thư mục dữ liệu, mặc định `./data`), `CDE_MAX_UPLOAD_MB` (mặc định 500).

## Chức năng

| Phân hệ | Nội dung |
|---|---|
| **Container thông tin** | Đặt tên chuẩn `Dự án-Đơn vị-Khối-Tầng-Loại-Bộ môn-Số hiệu` (vd. `HN01-KTA-ZZ-01-DR-A-0101`), kiểm tra hợp lệ, gợi ý số hiệu tiếp theo, tải lên phiên bản (lưu SHA-256), tải về. |
| **Trạng thái CDE** | WIP → Shared → Published → Archived. Container WIP chỉ hiển thị với đơn vị tạo lập (và quản lý thông tin); bên khác chỉ thấy phiên bản đã chia sẻ/phát hành. |
| **Sửa đổi (revision)** | `P01.1, P01.2…` (WIP) → `P01` (Shared) → `C01` (Published) → `P02.1`… |
| **Mã tình trạng** | S0 (WIP); S1–S4 (Shared); A1–A3, B1–B3, CR (Published); AR (Archived). |
| **Phê duyệt** | WIP→Shared do Trưởng nhóm kiểm tra; Shared→Published do Quản lý thông tin phê duyệt. Từ chối phải ghi lý do. Container bị khóa tải lên khi đang chờ duyệt. |
| **Vấn đề / RFI** | RFI, Vấn đề, Va chạm, NCR; mã tự động (`HN01-RFI-0001`), ưu tiên, người xử lý, hạn, trao đổi, liên kết container. |
| **Chuyển giao (Transmittal)** | Phiếu gửi các container Shared/Published kèm revision & mã tình trạng tại thời điểm gửi; người nhận xác nhận đã nhận. |
| **Thành viên & quyền** | Vai trò theo dự án: Xem / Thành viên nhóm / Trưởng nhóm / Quản lý thông tin. Mã đơn vị của người dùng = mã "Đơn vị tạo lập". |
| **Nhật ký** | Audit trail toàn bộ thao tác; bảng tổng quan theo trạng thái, bộ môn, vấn đề quá hạn. |

## Cấu trúc

```
cde/
├── server.js        Máy chủ HTTP + REST API (/api/...)
├── lib/cde.js       Quy tắc nghiệp vụ ISO 19650 (tên, revision, trạng thái, quyền)
├── lib/store.js     Lưu trữ JSON (ghi nguyên tử) + thư mục tệp
├── lib/demo.js      Dữ liệu mẫu
├── public/          Giao diện (HTML/CSS/JS thuần)
└── test/            Kiểm thử (npm test)
```

Dữ liệu nằm trong `data/db.json` và `data/files/` — sao lưu thư mục `data/` là đủ.

## Kiểm thử

```bash
npm test
```
