# Tactical Store

Static storefront for Arena Breakout accounts and in-game services (HTML + Tailwind CDN + Firebase Auth/Firestore).

## How an order works

1. Customer signs in, picks a product and files an order. The browser only writes a `pending_payment` order
   (`js/index.js`, `js/product.js`). It never sees stock or credentials.
2. An admin opens `front/admin.html` > Orders, checks the transfer slip / TrueMoney voucher by hand and presses
   **ยืนยันชำระ & ส่งมอบ**. That one transaction marks the stock item sold, decrements stock and sets the order
   to `completed` with `accountDelivered`.
3. The customer sees the credentials under "ออเดอร์ของฉัน" / account page once the order is `completed`.

## How a wallet top-up works

Same pattern: `js/topup.js` files a `pending` request (slip reference or TrueMoney link). Admin > Topups checks the
money arrived and presses **ยืนยัน & เติมเครดิต**; one transaction credits `users/{uid}.walletBalance` and marks the
request `completed`. Browsers cannot write `users/*`. Nothing in the shop spends the wallet balance yet.

## Categories and minimum order

Admin > หมวดหมู่สินค้า creates, edits and deletes categories (`categories/{id}` in Firestore). A category is either an
account/item category or a **service** category with a unit and a default minimum (ammo stacks: 15 กอง). A product's own
minimum (admin > product form) overrides it; leave it blank to inherit. Until the first category is saved the built-in list
in `js/categories.js` is used, and the first save copies it into Firestore. Minimums are enforced in the browser; check the
quantity when you approve an order.

## Credit display and top-up button

`js/shell.js` (a module tag on every customer page) adds the credit chip, a เติมเงิน button and, on phones, a bottom tab bar.
The credit is `users/{uid}.walletBalance`. Nothing in the shop can spend it yet.

## Automatic slip check (SlipOK)

Off by default. Slips are checked by `functions/` (Cloud Function `verifyTopupSlip`), never in the browser, so the key stays
private. To switch it on:

1. Upgrade the Firebase project to Blaze, then from the repo root: `cd functions && npm install && cd .. && firebase deploy --only functions,firestore:rules`.
2. Admin > Settings: enter the SlipOK API key and Branch ID, tick "เปิดตรวจสลิปอัตโนมัติ", save.
3. Test with a real small slip. The SlipOK request/response shape in `functions/slip.js` was written from memory of their docs and
   has not been run against the live API.

Each slip reference can credit once (`slip_refs`). If the switch is off or the function fails, the top-up page falls back to a
pending request that an admin approves. `node functions/test.js` runs the logic against fakes. TrueMoney is not automated.

## Page transitions

`css/transition.css` (native View Transitions: header stays, page fades and rises 10px) and `js/transition.js` (fade fallback for
Firefox) are linked from every page. Both switch off under `prefers-reduced-motion`. New pages need the same two tags.

## Before going live

- Deploy `firestore.rules` (Firebase console > Firestore > Rules, or `firebase deploy --only firestore:rules`).
- Make yourself admin: `GOOGLE_APPLICATION_CREDENTIALS=serviceAccount.json node scripts/set-admin-claim.js you@example.com`
  (needs `npm i firebase-admin`), then sign out and in again. Admin is a custom claim, not an email check.
- In admin > Settings fill in the PromptPay QR image URL and account name. Without them PromptPay is disabled.
- Leave the stat tiles and banner empty unless you have real numbers; they are hidden when empty.

## Known gaps

- Wallet credit cannot be spent on products yet (needs a server-side purchase function).
- Slip check is top-ups only; product orders paid by PromptPay are still approved by an admin.
- The TrueMoney key field in settings is unused; voucher links are still checked by hand.

- Order totals and promo discounts are computed in the browser. Compare each order's amount with the product
  price when you verify payment.
- Top-up bonus packs (+25, +80, +200 credit) are hard-coded in `front/topup.html` and the credit amount comes from the browser; check it when you approve.
- `account.js` shows the admin tab by email list (`ADMIN_EMAILS`), which is UI only; anyone can register that username. Data stays protected by the `admin` claim.
- `js/admin.js` still carries an unused copy of the old storefront checkout code (section 8).

## Product page packages (หน้าสินค้า)
Admin → product form → "แพ็กเกจ / ของแถม": one row per package `จำนวนที่ซื้อ แถมกี่หน่วย` (e.g. `20 8`). Price = qty × unit price; buying more than a tier keeps that tier's bonus. Also per product: hours/queue line, extra info lines, how-to and warranty text (accordion). Orders store `bonusQty`/`receiveQty`; the server does not verify them, so check when approving.

## Game-login for services
Service orders (โยน M61 etc.) ask for the customer's game email + password (`gameEmail`, `gamePassword` on the order). Admin → orders → "เสร็จงาน · ลบรหัสเกม" deletes the password. Until then it is readable by admin and the order owner. Index quick-checkout sends services to the product page. Account products: low-stock label, `key: value` spec lines render as cards, swipe/zoom gallery.

## Category cards + work queue
Home and category pages show category cards (name + optional image set in admin → หมวดหมู่) until a card, search or filter is chosen; a card opens its products.
Service orders also write a public `queue/{orderId}` doc (masked name, qty, status; no contact/credentials). Admin: approve payment → `processing` / queue `waiting`; "เริ่มทำ" → `working`; "เสร็จงาน" → order `completed`, queue `done`, game password deleted. Page `front/queue.html` lists per service the queue + 30-day history; open/close times are per product (admin product form). Queue statuses are not verified server-side beyond admin-only updates.
Deploy: republish `firestore.rules` (new `queue` collection).

## Theme, credit chip, cards, farm service
- Dark mode: button top-right on every customer page (`js/theme.js` + `css/theme.css`, inverts the light design, photos stay normal, saved in the browser). Admin page stays light.
- Credit: header chip (wallet icon + balance) opens a card with balance, top-up button and the last 4 top-ups.
- Product cards: `js/card.js`, shared by home and category pages. Emoji replaced by inline SVG icons.
- Farm service (category `service_farm` or any service): admin product form → "บริการพาฟาร์ม 2 แบบ" two prices (ให้ไอดีไปยืน / ไปยืนเอง; card shows the cheaper). "ให้ไอดี" asks game email+password (deleted when the job is finished); "ไปยืนเอง" asks in-game name/UID + available time. Orders carry `farmMode`, `playTime`. Republish `firestore.rules`.

## Security review (2026-10-17)
Fixed: slip check now requires the receiver on the slip to match `system_private/secrets.slipokReceiver` (otherwise a slip to any account credited the wallet; no receiver set = manual only); top-up rules cap bonus at 10% and force `finalCredit = amount + bonus` (a user could ask for any credit); order rules check quantity (int, >0), `subtotal = qty × unitPrice`, `amount = subtotal − discount` and `unitPrice ≥ catalogue price` (negative quantity would have raised stock on approve); queue docs must belong to an order in the same batch (fake public queue entries); string size caps; admin-controlled text escaped on the product page.
Still open: promo code validity/limits are checked in the browser only (admin verifies at approval); game passwords sit in the order as plain text until "เสร็จงาน"; rules are untested in the emulator (run `firebase emulators:start` and try an order, a top-up request and a queue entry before deploying); queue docs expose the customer's uid; no rate limit on creating orders/top-up requests; the admin PIN is a UI lock only.

## เติมเงินอัตโนมัติ (EasySlip + Cloudflare Worker, ฟรี)
1. สมัคร Cloudflare → Workers → Create → วางโค้ดจาก `worker/slip-worker.js` → Deploy
2. Settings → Variables ของ Worker:
   - Secret `EASYSLIP_KEY` = API key จาก EasySlip
   - Secret `SERVICE_ACCOUNT` = JSON service account ของ Firebase (Project settings → Service accounts → Generate key). ห้าม commit/แชร์
   - Text `RECEIVER_MATCH` = ส่วนของชื่อ/เลขบัญชีผู้รับที่ต้องตรง (สลิปโอนเข้าบัญชีอื่นไม่ผ่าน)
   - Text `ALLOWED_ORIGIN` (ไม่บังคับ) = โดเมนเว็บ
3. แอดมิน → ตั้งค่า: ใส่ URL ของ Worker, ติ๊ก "เปิดตรวจสลิปอัตโนมัติ", บันทึก
4. ทดสอบด้วยสลิปจริง 20 บาท. Publish `firestore.rules` ใหม่ (`slip_refs`, `slip_attempts` เฉพาะ server)
เบราว์เซอร์อ่าน QR บนสลิปเอง แล้วส่งข้อความ QR + Firebase token ไป Worker; Worker เช็ค EasySlip, ยอด, ผู้รับ, สลิปซ้ำ แล้วเติมเครดิตในคำสั่งเดียว. `functions/` (SlipOK) เป็นทางเลือกเก่า ไม่ต้องใช้
