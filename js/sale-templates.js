/** Chat templates for sending sold IDs to a customer (LINE / Facebook). {ids} is the list, {count} {ammo} {total} are filled in. */
export const SALE_TEMPLATES = [
  { id: 'raw', label: 'เฉพาะรายการ', text: '{ids}' },
  { id: 'short', label: 'สั้น กระชับ', text: 'ส่งไอดีครับ {count} ไอดี{ammoPart}\n\n{ids}\n\nเข้าแล้วเช็กให้ด้วยนะครับ ถ้าติดอะไรทักได้เลย 🙏' },
  { id: 'friendly', label: 'เป็นกันเอง', text: 'ได้แล้วนะครับ 🎉 ไอดีทั้งหมด {count} ไอดี{ammoPart}\n\n{ids}\n\n✅ ลองล็อกอินดูได้เลย\n💬 ถ้ามีปัญหา ทักมาได้ทุกเมื่อ ขอบคุณที่อุดหนุนครับ' },
  { id: 'formal', label: 'ทางการ', text: 'เรียนลูกค้า\n\nทางร้านขอจัดส่งไอดีตามรายการสั่งซื้อ จำนวน {count} ไอดี{ammoPart}{totalPart}\n\n{ids}\n\nข้อแนะนำหลังรับสินค้า\n1. ล็อกอินและตรวจสอบไอดีทันที\n2. เปลี่ยนรหัสผ่านและผูกอีเมลของท่าน\n3. หากพบปัญหา กรุณาแจ้งร้านพร้อมแคปหน้าจอ\n\nขอบคุณที่ใช้บริการ' },
  { id: 'summary', label: 'สรุปยอด', text: '📦 สรุปรายการส่งมอบ\n• จำนวน: {count} ไอดี\n{ammoLine}{totalLine}\n• ตอบรับเมื่อ: {date}\n\n{ids}\n\nตรวจรับแล้วพิมพ์ "รับแล้ว" ให้ด้วยนะครับ 🙏' },
  { id: 'care', label: 'แนะนำการใช้', text: 'ไอดีมาแล้วครับ ({count} ไอดี{ammoPart})\n\n{ids}\n\n⚠️ เพื่อความปลอดภัย\n• อย่าให้รหัสกับคนอื่น\n• เปลี่ยนรหัสผ่านหลังเข้าได้\n• ล็อกอินครั้งแรกบนเครื่องเดียวกันที่ใช้เล่นประจำ\n\nมีคำถามทักได้เลยครับ' }
];
const fmt = (n) => Number(n).toLocaleString('th-TH');
export function fillTemplate(id, { ids, count, ammo, total }) {
  const t = SALE_TEMPLATES.find(x => x.id === id) || SALE_TEMPLATES[0];
  const date = new Date().toLocaleString('th-TH', { dateStyle: 'medium', timeStyle: 'short' });
  const map = {
    ids, count: fmt(count), date,
    ammoPart: ammo ? ` · ${fmt(ammo)} กอง` : '', totalPart: total ? ` ยอดรวม ${fmt(total)} บาท` : '',
    ammoLine: ammo ? `• กระสุนรวม: ${fmt(ammo)} กอง\n` : '', totalLine: total ? `• ยอดรวม: ${fmt(total)} บาท\n` : ''
  };
  return t.text.replace(/\{(\w+)\}/g, (_, k) => map[k] ?? '');
}
