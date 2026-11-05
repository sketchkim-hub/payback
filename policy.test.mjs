import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  MIN_PURCHASE, PAYOUT_AMOUNT, PAYOUT_CAP, MAX_PURCHASE,
  cleanName, couponFor, makeDupKey, decidePayout, summarizeVouchers,
  validateEntry, isPayoutRecord, budgetStatusText, personDocId, phoneLockId,
  phoneConflict, isValidPhone, isValidBirth, parseWon, effectiveDailyBudget, ledgerDocId,
  isEventDate, defaultEventDate, DAILY_BUDGET_CAP, EVENT_ID, scopeForDate,
  filterStores
} from "./policy.js";

const base = {
  amount: 35000,
  paid: 0,
  phoneUsed: false,
  recordExists: false,
  budgetIssued: 0,
  dailyBudget: 2500000
};

test("3만원 이상은 구매액과 관계없이 1만원이다", () => {
  assert.equal(couponFor(29999), 0);
  assert.equal(couponFor(MIN_PURCHASE), PAYOUT_AMOUNT);
  assert.equal(couponFor(49999), PAYOUT_AMOUNT);
  assert.equal(couponFor(50000), PAYOUT_AMOUNT);
  assert.equal(couponFor(MAX_PURCHASE), PAYOUT_AMOUNT);
  assert.equal(couponFor(MAX_PURCHASE + 1), 0);
  assert.equal(couponFor("35,000"), PAYOUT_AMOUNT);
  assert.equal(PAYOUT_AMOUNT, PAYOUT_CAP);
});

test("한도를 한 번이라도 쓰면 차액을 채우지 않는다", () => {
  assert.equal(decidePayout(base).ok, true);
  assert.equal(decidePayout(base).grant, 10000);
  const partial = decidePayout({ ...base, paid: 5000 });
  assert.equal(partial.ok, false);
  assert.equal(partial.code, "cap");
  assert.match(partial.message, /5,000원/);
  assert.match(partial.message, /이번 행사 1인 1회/);
  assert.doesNotMatch(partial.message, /올해/);
  assert.equal(decidePayout({ ...base, paid: 10000 }).code, "cap");
  assert.equal(decidePayout({ ...base, recordExists: true }).code, "duplicate");
});

test("휴대폰·예산·금액 검증", () => {
  assert.equal(decidePayout({ ...base, phoneUsed: true }).code, "phone");
  assert.equal(decidePayout({ ...base, amount: 10000 }).code, "amount-low");
  assert.equal(decidePayout({ ...base, amount: MAX_PURCHASE + 1 }).code, "amount-high");
  assert.equal(decidePayout({ ...base, amount: null }).code, "amount-invalid");
  assert.equal(decidePayout({ ...base, budgetIssued: 2490000 }).ok, true);
  assert.equal(decidePayout({ ...base, budgetIssued: 2490001 }).code, "budget");
  assert.equal(decidePayout({ ...base, budgetIssued: 2500000 }).code, "budget");
  assert.equal(decidePayout({ ...base, budgetIssued: 2490000, dailyBudget: 3000000 }).ok, true);
  assert.equal(effectiveDailyBudget(3000000), DAILY_BUDGET_CAP);
  assert.equal(effectiveDailyBudget(1000000), 1000000);
});

test("예외 지급도 예산과 휴대폰은 넘지 못한다", () => {
  const over = decidePayout({ ...base, paid: 10000, allowCapBypass: true });
  assert.equal(over.ok, true);
  assert.equal(decidePayout({ ...base, paid: 10000, allowCapBypass: true, phoneUsed: true }).code, "phone");
  assert.equal(decidePayout({ ...base, paid: 10000, allowCapBypass: true, budgetIssued: 2500000 }).code, "budget");
  assert.equal(decidePayout({ ...base, amount: 20000, allowCapBypass: true }).code, "amount-low");
});

test("기존 5천원과 신규 1만원을 같이 집계한다", () => {
  const mixed = summarizeVouchers([5000, 5000, 10000, 0]);
  assert.equal(mixed.n5, 2);
  assert.equal(mixed.n10, 1);
  assert.equal(mixed.total, 20000);
  assert.equal(mixed.sheets, 4);
  assert.match(mixed.note, /기존 5천원/);
  assert.match(mixed.note, /1만원/);
  const onlyNew = summarizeVouchers([10000, 10000]);
  assert.equal(onlyNew.sheets, 4);
  assert.match(onlyNew.note, /각 2매/);
  assert.doesNotMatch(onlyNew.note, /5천원 지급/);
  const onlyOld = summarizeVouchers([5000]);
  assert.equal(onlyOld.sheets, 1);
  assert.match(onlyOld.note, /각 1매/);
});

test("하루 예산 문구는 1만원 건수만 보여 준다", () => {
  const ok = budgetStatusText(10000, 2500000);
  assert.equal(ok.limit, 2500000);
  assert.equal(ok.slots, 249);
  assert.match(ok.line, /1만원 환급/);
  assert.doesNotMatch(ok.line, /5천원권/);
  const tight = budgetStatusText(2495000, 2500000);
  assert.equal(tight.blocked, true);
  assert.match(tight.line, /접수할 수 없습니다/);
});

test("입력 검증", () => {
  const good = validateEntry({
    date: "2026-11-06", name: "홍 길동", birth: "1979-10-10",
    phone: "010-1234-5678", district: "동구", amount: "35,000", consent: true,
    now: new Date("2026-11-04T00:00:00")
  });
  assert.equal(good.ok, true);
  assert.equal(good.nameNorm, "홍길동");
  assert.equal(good.phone, "01012345678");
  assert.equal(good.amount, 35000);
  const young = validateEntry({
    date: "2026-11-06", name: "홍길동", birth: "2027-01-01",
    phone: "01012345678", district: "동구", amount: 30000, consent: true,
    now: new Date("2026-11-04T00:00:00")
  });
  assert.equal(young.ok, false);
  const badPhone = validateEntry({
    date: "2026-11-07", name: "홍길동", birth: "1979-10-10",
    phone: "123", district: "동구", amount: 35000, consent: true,
    now: new Date("2026-11-04")
  });
  assert.equal(badPhone.ok, false);
  assert.equal(badPhone.errors[0].code, "phone-invalid");
  assert.equal(isValidPhone("0101234567"), false);
  assert.equal(isValidPhone("0111234567"), true);
  assert.equal(isValidBirth("1899-01-01", new Date("2026-01-01")), false);
  assert.equal(parseWon("00"), 0);
  assert.equal(isEventDate("2026-11-06"), true);
  assert.equal(isEventDate("2026-11-07"), true);
  assert.equal(isEventDate("2026-11-05"), false);
  assert.equal(defaultEventDate("2026-11-04"), "2026-11-06");
  assert.equal(defaultEventDate("2026-11-07"), "2026-11-07");
  assert.equal(defaultEventDate("2026-11-08"), "2026-11-07");
  const outside = validateEntry({
    date: "2026-11-05", name: "홍길동", birth: "1979-10-10",
    phone: "01012345678", district: "동구", amount: 35000, consent: true,
    now: new Date("2026-11-04")
  });
  assert.equal(outside.ok, false);
  assert.equal(outside.errors[0].code, "date");
  assert.equal(cleanName("홍길동(김)"), "홍길동김");
});

test("지급 기록이 아닌 잠금 문서는 집계에서 빠진다", () => {
  assert.equal(isPayoutRecord({ id: "abc", name: "홍길동", coupon: 5000 }), true);
  assert.equal(isPayoutRecord({ id: "rec_홍길동_1979-10-10_2026", name: "홍길동", coupon: 10000 }), true);
  assert.equal(isPayoutRecord({ id: "phone_01012345678_2026", phoneLock: true, name: "홍길동", coupon: 10000 }), false);
  assert.equal(isPayoutRecord({ id: "legacy_홍길동_1979-10-10_2026", legacyLock: true }), false);
  assert.equal(isPayoutRecord({ id: "budget_2026-11-04", budget: true }), false);
  assert.equal(isPayoutRecord({ id: "ledger_aa_2026", ledger: true, name: "x", coupon: 10000 }), false);
});

test("문서 ID는 사람·휴대폰을 나눈다", () => {
  assert.equal(personDocId("홍길동", "1979-10-10", "2026"), "rec_홍길동_1979-10-10_2026");
  assert.equal(personDocId("홍길동", "1979-10-10", EVENT_ID), "rec_홍길동_1979-10-10_2026-11");
  assert.notEqual(ledgerDocId("a".repeat(64), "2026"), ledgerDocId("a".repeat(64), EVENT_ID));
  assert.equal(scopeForDate("2026-11-06"), EVENT_ID);
  assert.equal(scopeForDate("2026-08-01"), "2026");
  assert.equal(phoneLockId("01012345678", EVENT_ID), "phone_01012345678_2026-11");
  assert.equal(phoneConflict(null, "aa"), "free");
  assert.equal(phoneConflict({ dupKey: "aa", pending: true }, "aa"), "ours");
  assert.equal(phoneConflict({ dupKey: "bb", pending: true }, "aa"), "other");
  assert.equal(phoneConflict({ dupKey: "aa", pending: false }, "aa"), "used");
});

test("중복 키는 이름+생년월일만 쓰고 휴대폰은 넣지 않는다", async () => {
  const a = await makeDupKey("홍길동", "1979-10-10");
  const b = await makeDupKey("홍 길동", "1979-10-10");
  assert.equal(a, b);
  assert.equal(a.length, 64);
});

test("점포명은 두 글자 이상 부분 일치로 찾는다", () => {
  const stores = [{ name: "영광상회", cat: "잡화" }, { name: "청과", cat: "농산물" }, { name: "영 광 마트" }];
  assert.deepEqual(filterStores(stores, "영").map(s => s.name), []);
  assert.deepEqual(filterStores(stores, "영광").map(s => s.name).sort(), ["영광상회", "영 광 마트"].sort());
  assert.deepEqual(filterStores(stores, "  영 광 ").map(s => s.name).sort(), ["영광상회", "영 광 마트"].sort());
  assert.deepEqual(filterStores(stores, "청과").map(s => s.name), ["청과"]);
});

test("화면 문구가 새 지급 조건과 같다", () => {
  const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
  assert.match(html, /3만원 이상 구매/);
  assert.match(html, /10,000원 환급/);
  assert.match(html, /이번 행사 1인 1회/);
  assert.match(html, /id="storeSuggest"/);
  assert.match(html, /점포 명단을 불러오지 못했습니다\(권한\)/);
  assert.match(html, /position:static/);
  assert.doesNotMatch(html, /list="storeOptions"/);
  assert.doesNotMatch(html, /1인 연 1회/);
  assert.doesNotMatch(html, /잠금 갱신/);
  assert.match(html, /상품권 \(5천원권\)/);
  assert.match(html, /from "\.\/policy\.js"/);
  assert.match(html, /2026-11-06/);
  assert.match(html, /2026-11-07/);
  assert.match(html, /2,500,000/);
  assert.doesNotMatch(html, /3,000,000/);
  assert.doesNotMatch(html, /5만원 이상/);
  assert.doesNotMatch(html, /3만원↑ 5천원/);
  assert.doesNotMatch(html, /amt>=50000/);
  assert.doesNotMatch(html, /지급 계속 가능/);
  assert.doesNotMatch(html, /초과해도 접수는 차단되지 않고/);
  assert.doesNotMatch(html, /data-v="5000"/);
  const rules = readFileSync(new URL("./firestore.rules", import.meta.url), "utf8");
  assert.match(rules, /d\.amount >= 30000/);
  assert.match(rules, /d\.coupon == 10000/);
  assert.match(rules, /legacyBlocks/);
  assert.match(rules, /dailyLimit/);
  assert.match(rules, /2500000/);
  assert.match(rules, /2026-11-06/);
  assert.match(rules, /2026-11-07/);
  assert.match(rules, /2026-11/);
  assert.match(rules, /eventRound/);
  assert.doesNotMatch(rules, /3000000/);
});
