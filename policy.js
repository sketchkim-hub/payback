/**
 * 문창전통시장 페이백 지급 정책.
 *
 * 신규 지급은 "3만원 이상 구매 → 10,000원" 한 단계다. 5천원 단계는 없다.
 * 한도는 기존과 같이 신청 연도 기준 1인 10,000원이다. 지급액과 같으므로
 * 1인 연 1회(1만원)다. 예전에 5,000원만 받은 사람도 그 해에 한 번 참여한
 * 것으로 보고, 남은 5,000원을 채워 주지 않는다.
 * 사람 식별은 기존 원장과 같게 이름+생년월일이다. 휴대폰 번호는 추가로
 * 같은 해 재사용을 막는다.
 */

export const MIN_PURCHASE = 30000;
export const MAX_PURCHASE = 10000000;
export const PAYOUT_AMOUNT = 10000;
export const PAYOUT_CAP = 10000;
export const VOUCHER_UNIT = 5000;
export const DEFAULT_DAILY_BUDGET = 3000000;
export const DISTRICTS = ["동구", "중구", "서구", "유성구", "대덕구", "그 외"];

export function won(n) {
  return Number(n || 0).toLocaleString("ko-KR");
}

export function cleanName(s) {
  return String(s || "").replace(/[^가-힣A-Za-z0-9]/g, "");
}

export function digitsOnly(s) {
  return String(s || "").replace(/\D/g, "");
}

export function yearOf(d) {
  return String(d || "").slice(0, 4);
}

export function parseWon(value) {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) return null;
    return value;
  }
  const digits = digitsOnly(value);
  if (!digits) return null;
  const n = Number(digits);
  if (!Number.isSafeInteger(n)) return null;
  return n;
}

export function isValidBirth(iso, now = new Date()) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(iso || ""))) return false;
  const [y, m, d] = iso.split("-").map(Number);
  if (y < 1900) return false;
  const dt = new Date(y, m - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) return false;
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return dt <= today;
}

export function isValidPhone(digits) {
  return /^01(?:0\d{8}|[16789]\d{7,8})$/.test(String(digits || ""));
}

/** 3만원 이상이면 항상 1만원. 5만원 구간은 더 이상 나누지 않는다. */
export function couponFor(amount) {
  const n = typeof amount === "number" ? amount : parseWon(amount);
  if (!Number.isInteger(n) || n < MIN_PURCHASE || n > MAX_PURCHASE) return 0;
  return PAYOUT_AMOUNT;
}

export async function makeDupKey(name, birth) {
  const raw = cleanName(name) + "|" + birth;
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}

export function personDocId(nameNorm, birth, year) {
  return `rec_${nameNorm}_${birth}_${year}`;
}

export function legacyLockId(nameNorm, birth, year) {
  return `legacy_${nameNorm}_${birth}_${year}`;
}

export function phoneLockId(phone, year) {
  return `phone_${phone}_${year}`;
}

export function ledgerDocId(dupKey, year) {
  return `ledger_${dupKey}_${year}`;
}

export function exceptionDocId(dupKey, year, phone) {
  return `ex_${dupKey}_${year}_${phone}`;
}

export function isPayoutRecord(r) {
  if (!r || typeof r !== "object") return false;
  const id = String(r.id || "");
  if (
    id.startsWith("phone_") || id.startsWith("legacy_") || id.startsWith("ledger_") ||
    id.startsWith("budget_") || id === "_config_admins" || id === "_stores"
  ) return false;
  if (r.ledger || r.config || r.budget || r.phoneLock || r.legacyLock) return false;
  return typeof r.name === "string" && r.name.trim().length > 0 && Number.isFinite(Number(r.coupon));
}

export function samePerson(record, nameNorm, birth, dupKey) {
  if (!record) return false;
  if (dupKey && record.dupKey) return record.dupKey === dupKey;
  const n = record.nameNorm || cleanName(record.name);
  return n === nameNorm && record.birth === birth;
}

/** 휴대폰 잠금 문서 상태. free=없음, ours=진행 중 예약, other=다른 사람, used=이미 사용. */
export function phoneConflict(lock, dupKey) {
  if (!lock) return "free";
  if (lock.dupKey && dupKey && lock.dupKey !== dupKey) return "other";
  if (lock.pending === true && lock.dupKey === dupKey) return "ours";
  return "used";
}

function fail(code, message) {
  return { ok: false, grant: 0, code, message };
}

/**
 * 접수 가능 여부. allowCapBypass는 대표의 동명이인 예외 지급에만 쓴다.
 * 예외라도 3만원 미만, 휴대폰 재사용, 하루 예산 초과는 통과하지 않는다.
 */
export function decidePayout(input) {
  const amount = typeof input.amount === "number" ? input.amount : parseWon(input.amount);
  const paid = Math.max(0, Number(input.paid) || 0);
  const issued = Math.max(0, Number(input.budgetIssued) || 0);
  const limit = Number(input.dailyBudget) > 0 ? Number(input.dailyBudget) : DEFAULT_DAILY_BUDGET;

  if (!Number.isInteger(amount)) return fail("amount-invalid", "구매금액은 숫자로 입력해 주세요.");
  if (amount > MAX_PURCHASE) return fail("amount-high", `구매금액이 너무 큽니다. ${won(MAX_PURCHASE)}원 이하로 입력해 주세요.`);
  if (amount < MIN_PURCHASE) return fail("amount-low", `구매금액이 3만원 미만입니다. (입력: ${won(amount)}원)`);

  if (input.phoneUsed && (input.allowCapBypass || paid <= 0)) {
    return fail("phone", "이 휴대폰 번호로 올해 이미 지급된 기록이 있습니다.");
  }
  if (!input.allowCapBypass && paid + PAYOUT_AMOUNT > PAYOUT_CAP) {
    const message = paid > 0 && paid < PAYOUT_CAP
      ? `이미 올해 ${won(paid)}원을 지급받은 고객입니다. 1인 연 1회(1만원)이라 차액을 채우거나 다시 지급할 수 없습니다.`
      : `이미 올해 한도(${won(PAYOUT_CAP)}원)를 지급받은 고객입니다. 1인 연 1회만 가능합니다.`;
    return fail("cap", message);
  }
  if (!input.allowCapBypass && input.recordExists) {
    return fail("duplicate", "같은 이름·생년월일로 올해 이미 접수된 기록이 있습니다. 1인 연 1회(1만원)만 지급됩니다.");
  }
  if (issued + PAYOUT_AMOUNT > limit) {
    const rem = Math.max(0, limit - issued);
    return fail("budget", `하루 지급 예산이 부족합니다. (남은 ${won(rem)}원, 1회 ${won(PAYOUT_AMOUNT)}원)`);
  }
  return { ok: true, grant: PAYOUT_AMOUNT, code: "ok", message: "", amount, paid, issued };
}

export function validateEntry(fields) {
  const errors = [];
  const date = String(fields.date || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) errors.push({ code: "date", message: "신청일자를 확인해 주세요." });
  const nameNorm = cleanName(fields.name);
  if (nameNorm.length < 2 || nameNorm.length > 30) errors.push({ code: "name", message: "이름은 2글자 이상 입력해 주세요." });
  const birth = fields.birth;
  if (!birth) errors.push({ code: "birth", message: "생년월일을 입력해 주세요." });
  else if (birth === "INVALID" || !isValidBirth(birth, fields.now)) errors.push({ code: "birth", message: "생년월일이 올바르지 않습니다." });
  const phone = digitsOnly(fields.phone);
  if (!isValidPhone(phone)) errors.push({ code: "phone-invalid", message: "올바른 휴대폰 번호를 입력해 주세요." });
  if (!DISTRICTS.includes(fields.district)) errors.push({ code: "district", message: "거주 지역(구)을 선택해 주세요." });
  if (!fields.consent) errors.push({ code: "consent", message: "개인정보 수집·이용에 동의해야 접수할 수 있습니다." });
  const amount = parseWon(fields.amount);
  if (amount == null) errors.push({ code: "amount-invalid", message: "구매금액은 숫자로 입력해 주세요." });
  return { ok: errors.length === 0, errors, nameNorm, phone, amount, year: yearOf(date) };
}

/** 실물 5천원권 매수. 신규 1만원은 2매, 기존 5천원 기록은 1매로 남긴다. */
export function summarizeVouchers(coupons) {
  let n5 = 0, n10 = 0, other = 0, total = 0;
  for (const raw of coupons || []) {
    const c = Number(raw) || 0;
    if (!c) continue;
    total += c;
    if (c === 5000) n5 += 1;
    else if (c === 10000) n10 += 1;
    else other += 1;
  }
  const sheets = total / VOUCHER_UNIT;
  const sheetLabel = Number.isInteger(sheets) ? String(sheets) : sheets.toFixed(1);
  let note;
  if (n5 === 0 && n10 === 0 && other === 0) note = "지급 없음";
  else if (other > 0) note = `1만원 ${n10}건 · 기존 5천원 ${n5}건 · 기타 ${other}건`;
  else if (n5 === 0) note = `1만원 지급 ${n10}건 = 각 2매`;
  else if (n10 === 0) note = `기존 5천원 지급 ${n5}건 = 각 1매`;
  else note = `1만원 ${n10}건(2매) · 기존 5천원 ${n5}건(1매)`;
  return { n5, n10, other, total, sheets, sheetLabel, note };
}

export function budgetStatusText(issued, dailyBudget) {
  const limit = Number(dailyBudget) > 0 ? Number(dailyBudget) : DEFAULT_DAILY_BUDGET;
  const used = Math.max(0, Number(issued) || 0);
  const remaining = limit - used;
  const slots = Math.floor(Math.max(0, remaining) / PAYOUT_AMOUNT);
  const over = remaining < 0;
  const blocked = remaining < PAYOUT_AMOUNT;
  let line;
  if (over) line = `하루 예산을 ${won(-remaining)}원 초과했습니다. 이 날짜는 더 접수할 수 없습니다.`;
  else if (blocked) line = `남은 예산이 ${won(remaining)}원입니다. 1만원 환급을 더 접수할 수 없습니다.`;
  else line = `남은 예산 ${won(remaining)}원 — 1만원 환급 ${slots}건 가능`;
  return { used, remaining, slots, over, blocked, line, limit };
}

const BLOCK_TITLES = {
  cap: "지급 한도",
  phone: "휴대폰 중복",
  "phone-invalid": "전화번호 확인",
  duplicate: "중복 접수",
  budget: "예산 소진",
  "amount-low": "지급 대상 아님",
  "amount-high": "금액 확인",
  "amount-invalid": "금액 확인",
  date: "입력 확인",
  name: "입력 확인",
  birth: "생년월일 확인",
  district: "지역 선택",
  consent: "동의 필요"
};

export function blockTitle(code) {
  return BLOCK_TITLES[code] || "접수할 수 없음";
}
