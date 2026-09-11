// Core aggregation logic for the Trip Ledger dashboard.
// Pure function: takes the raw 2D array of sheet values (header row + data rows)
// and returns the JSON payload the frontend renders. Kept separate from the
// Google auth/fetch wrapper so it can be unit-tested against real exported data.

const COLS = {
  DATE: 0, TRUCK: 1, TICKET: 2, DSC: 3, WEEK: 4, MONTHNO: 5, CLIENT: 6, ROUTE: 7,
  DRIVER: 8, HELPER1: 9, HELPER2: 10, AMOUNT: 11, MOP: 12, ODO: 13, FUEL: 14,
  LITRES: 15, PARKING: 16, PASSWAY: 17, OTHERS: 18, REMARKS1: 19, PITIK1: 20,
  CREW1: 21, PITIK2: 22, CREW2: 23, PITIK3: 24, CREW3: 25, EXPENSE: 26, REMARKS2: 27
};

function num(x) {
  if (x === undefined || x === null || x === '' || x === '-') return 0;
  if (typeof x === 'number') return x;
  const cleaned = String(x).replace(/[₱,]/g, '').trim();
  // Require the WHOLE cell to be a plain number (optionally signed/decimal) -
  // stray data-entry artifacts like "500/500" or "12 & 14" must read as 0
  // rather than have parseFloat silently take just the leading digits.
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return 0;
  const n = parseFloat(cleaned);
  return isNaN(n) ? 0 : n;
}

function cell(row, idx) {
  return idx < row.length ? row[idx] : undefined;
}

function parseSheetDate(v) {
  if (v === undefined || v === null || v === '') return null;
  // UNFORMATTED_VALUE + dateTimeRenderOption=FORMATTED_STRING returns dates as
  // locale strings like "1/2/2026" or, for some locales, "2026-01-02". Try both.
  if (typeof v === 'string') {
    let m = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (m) return new Date(Date.UTC(+m[3], +m[1] - 1, +m[2]));
    m = v.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  }
  if (typeof v === 'number') {
    // Sheets serial date (days since 1899-12-30), in case UNFORMATTED_VALUE slips through
    const epoch = Date.UTC(1899, 11, 30);
    return new Date(epoch + v * 86400000);
  }
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

function ymKey(d) { return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0'); }
function monthLabel(ym) {
  const names = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return names[parseInt(ym.split('-')[1], 10) - 1];
}
function dateLabel(d) {
  return String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0');
}
function fullDate(d) {
  return d.toISOString().slice(0, 10);
}

function compute(rows) {
  // rows[0] is the header; data starts at rows[1]. Sheets API omits trailing
  // blank cells per row, so index access must tolerate short rows.
  const data = rows.slice(1);

  const records = [];
  for (const row of data) {
    const dateVal = cell(row, COLS.DATE);
    const d = parseSheetDate(dateVal);
    if (!d) continue; // skip separator/blank rows
    const truck = String(cell(row, COLS.TRUCK) || '').trim();
    const client = String(cell(row, COLS.CLIENT) || '').trim();
    if (!truck && !client) continue; // dated but otherwise-empty template row (e.g. tomorrow's blank placeholder)
    records.push({
      date: d,
      ym: ymKey(d),
      truck,
      client: String(cell(row, COLS.CLIENT) || '').trim().toUpperCase(),
      route: String(cell(row, COLS.ROUTE) || '').trim(),
      driver: String(cell(row, COLS.DRIVER) || '').trim(),
      helper1: String(cell(row, COLS.HELPER1) || '').trim(),
      helper2: String(cell(row, COLS.HELPER2) || '').trim(),
      amount: num(cell(row, COLS.AMOUNT)),
      fuel: num(cell(row, COLS.FUEL)),
      parking: num(cell(row, COLS.PARKING)),
      passway: num(cell(row, COLS.PASSWAY)),
      others: num(cell(row, COLS.OTHERS)),
      pitik: num(cell(row, COLS.PITIK1)) + num(cell(row, COLS.PITIK2)) + num(cell(row, COLS.PITIK3)),
      expense: num(cell(row, COLS.EXPENSE))
    });
  }

  if (!records.length) {
    throw new Error('No dated rows found in the TRIPS sheet — check the range/header row.');
  }

  records.sort((a, b) => a.date - b.date);
  const minDate = records[0].date, maxDate = records[records.length - 1].date;

  // ---- month list actually present, in order ----
  const monthSet = new Set(records.map(r => r.ym));
  const months = Array.from(monthSet).sort();
  const monthLabels = months.map(monthLabel);

  // ---- truck x month trip-count pivot (truck codes only, e.g. T1..T13) ----
  const truckRe = /^T\d+$/;
  const truckRecords = records.filter(r => truckRe.test(r.truck));
  const trucks = Array.from(new Set(truckRecords.map(r => r.truck))).sort((a, b) => (+a.slice(1)) - (+b.slice(1)));

  const pivot = {}; // truck -> {ym: count}
  trucks.forEach(t => { pivot[t] = {}; months.forEach(m => pivot[t][m] = 0); });
  truckRecords.forEach(r => { pivot[r.truck][r.ym] = (pivot[r.truck][r.ym] || 0) + 1; });

  const truckTotals = trucks.map(t => ({
    truck: t,
    counts: months.map(m => pivot[t][m] || 0),
    total: months.reduce((s, m) => s + (pivot[t][m] || 0), 0)
  }));
  const sortedTotals = [...truckTotals].sort((a, b) => b.total - a.total);
  truckTotals.forEach(tt => {
    tt.rank = 1 + sortedTotals.filter(o => o.total > tt.total).length;
  });

  const monthTotals = months.map(m => trucks.reduce((s, t) => s + (pivot[t][m] || 0), 0));
  const grandTrips = monthTotals.reduce((a, b) => a + b, 0);

  // ---- monthly financial trend ----
  const byMonth = {};
  months.forEach(m => byMonth[m] = { fuel: 0, parking: 0, passway: 0, others: 0, pitik: 0, expense: 0, amount: 0, trips: 0 });
  records.forEach(r => {
    const b = byMonth[r.ym];
    b.fuel += r.fuel; b.parking += r.parking; b.passway += r.passway; b.others += r.others;
    b.pitik += r.pitik; b.expense += r.expense; b.amount += r.amount; b.trips += 1;
  });

  const cashOutByMonth = months.map(m => Math.round(byMonth[m].expense));
  const fuelCashedByMonth = months.map(m => Math.round(byMonth[m].fuel));

  // ---- YTD category totals ----
  const cat = { fuel: 0, parking: 0, passway: 0, others: 0, pitik: 0 };
  records.forEach(r => { cat.fuel += r.fuel; cat.parking += r.parking; cat.passway += r.passway; cat.others += r.others; cat.pitik += r.pitik; });
  const cashOutTotal = Math.round(records.reduce((s, r) => s + r.expense, 0));
  const fuelLoadedTotal = Math.round(records.reduce((s, r) => s + r.amount, 0));

  const categoryChart = Object.entries({
    'Fuel cashed': cat.fuel, 'Crew pitik': cat.pitik, 'Parking': cat.parking,
    'Others / misc': cat.others, 'Passway (toll)': cat.passway
  }).map(([label, value]) => ({ label, value: Math.round(value) }))
    .sort((a, b) => b.value - a.value);

  // ---- shipper share ----
  const shipperCounts = {};
  records.forEach(r => { if (r.client) shipperCounts[r.client] = (shipperCounts[r.client] || 0) + 1; });
  const shipperEntries = Object.entries(shipperCounts).sort((a, b) => b[1] - a[1]);
  const topN = 3;
  const shipperShare = shipperEntries.slice(0, topN).map(([label, value]) => ({ label: titleCase(label), value }));
  const otherTotal = shipperEntries.slice(topN).reduce((s, [, v]) => s + v, 0);
  if (otherTotal > 0) shipperShare.push({ label: 'Other', value: otherTotal });

  function titleCase(s) { return s.charAt(0) + s.slice(1).toLowerCase(); }

  // ---- recent trips (latest 2 distinct dates present) ----
  const distinctDates = Array.from(new Set(records.map(r => fullDate(r.date)))).sort();
  const latestDates = distinctDates.slice(-2);
  const recent = records
    .filter(r => latestDates.includes(fullDate(r.date)))
    .sort((a, b) => a.date - b.date || a.truck.localeCompare(b.truck))
    .slice(-24)
    .map(r => ({
      date: dateLabel(r.date), truck: r.truck, client: titleCase(r.client),
      route: r.route || '—', driver: r.driver, helper: r.helper2 ? r.helper1 + ' +1' : (r.helper1 || '—'),
      expense: Math.round(r.expense)
    }));

  // ---- "on the road" KPI: trucks active on the most recent date ----
  const latestDateStr = distinctDates[distinctDates.length - 1];
  const prevDateStr = distinctDates.length > 1 ? distinctDates[distinctDates.length - 2] : null;
  const activeToday = new Set(truckRecords.filter(r => fullDate(r.date) === latestDateStr).map(r => r.truck));
  const activePrev = prevDateStr ? new Set(truckRecords.filter(r => fullDate(r.date) === prevDateStr).map(r => r.truck)) : new Set();
  const rosterSize = trucks.length;

  // ---- flags (data-driven) ----
  const flags = [];

  // a) fuel-cash spike month
  if (fuelCashedByMonth.length >= 3) {
    const maxV = Math.max(...fuelCashedByMonth);
    const maxIdx = fuelCashedByMonth.indexOf(maxV);
    const rest = fuelCashedByMonth.filter((_, i) => i !== maxIdx);
    const restSorted = [...rest].sort((a, b) => a - b);
    const median = restSorted[Math.floor(restSorted.length / 2)] || 0;
    if (maxV > 0 && median >= 0 && maxV > (median || 1) * 4) {
      flags.push({
        level: 'crit',
        title: `Fuel-cash spike in ${monthLabels[maxIdx]}`,
        desc: `₱${maxV.toLocaleString()} cashed for fuel that month vs a typical ₱${Math.min(...rest).toLocaleString()}–₱${Math.max(...rest).toLocaleString()} range every other month YTD. Worth a second look.`
      });
    }
  }

  // b) pitik vs the small stuff
  const smallStuff = cat.parking + cat.passway + cat.others;
  if (cat.pitik > smallStuff) {
    flags.push({
      level: 'warn',
      title: 'Crew pitik outweighs the small stuff',
      desc: `Pitik (driver/helper incidentals) totals ₱${Math.round(cat.pitik).toLocaleString()} YTD — more than parking, toll and misc combined (₱${Math.round(smallStuff).toLocaleString()}).`
    });
  }

  // c) trucks gone quiet: had trips in an earlier month, none in the last full month present
  if (months.length >= 2) {
    const lastFullMonth = months[months.length - 2]; // treat the very last month as still-in-progress
    const earlierMonths = months.slice(0, -2);
    trucks.forEach(t => {
      const hadEarlier = earlierMonths.some(m => (pivot[t][m] || 0) >= 5);
      const quietRecently = (pivot[t][lastFullMonth] || 0) === 0 && (pivot[t][months[months.length - 1]] || 0) === 0;
      if (hadEarlier && quietRecently) {
        flags.push({
          level: 'warn',
          title: `${t} went quiet recently`,
          desc: `No trips logged in ${monthLabel(months[months.length - 1])} or ${monthLabel(lastFullMonth)} after regular activity earlier in the year — worth checking if it's down for maintenance.`
        });
      }
    });
  }

  // d) newcomer ramping up: first trip within the last 3 present months, increasing since
  const last3 = months.slice(-3);
  trucks.forEach(t => {
    const firstMonth = months.find(m => (pivot[t][m] || 0) > 0);
    if (firstMonth && last3.includes(firstMonth)) {
      const counts = last3.map(m => pivot[t][m] || 0);
      flags.push({
        level: 'info',
        title: `${t} is new to the roster`,
        desc: `First trip in ${monthLabel(firstMonth)}; ` + last3.map((m, i) => `${counts[i]} in ${monthLabel(m)}`).join(', ') + '.'
      });
    }
  });

  return {
    generatedAt: new Date().toISOString(),
    range: { from: fullDate(minDate), to: fullDate(maxDate) },
    kpis: {
      trips: grandTrips,
      rosterSize,
      cashOutTotal,
      fuelLoadedTotal,
      activeToday: activeToday.size,
      activePrevCount: activePrev.size,
      latestDateLabel: dateLabel(records[records.length - 1].date)
    },
    months: monthLabels,
    cashOutByMonth,
    fuelCashedByMonth,
    categoryChart,
    heatmap: { trucks: truckTotals, monthLabels },
    shipperShare,
    recent,
    flags: flags.slice(0, 6)
  };
}

// ---- MONTHLY OPX tab: office/admin/yard expenses, separate from per-trip cash-out ----
const OPX_COLS = { DATE: 0, PARTICULARS: 1, REMARKS: 2, AMOUNT: 3, CREW: 4, WEEK: 5, MONTHNO: 6 };

function titleCaseWords(s) {
  return s.split(' ').map(w => w ? w.charAt(0) + w.slice(1).toLowerCase() : w).join(' ');
}

function computeOpx(rows) {
  if (!rows || rows.length < 2) {
    return { months: [], totals: [], categoryChart: [], grandTotal: 0 };
  }
  const data = rows.slice(1);
  const records = [];
  for (const row of data) {
    const d = parseSheetDate(cell(row, OPX_COLS.DATE));
    const amt = num(cell(row, OPX_COLS.AMOUNT));
    if (!d || !amt) continue; // skip blank/separator rows and zero-amount rows
    const particulars = String(cell(row, OPX_COLS.PARTICULARS) || '').trim();
    records.push({ date: d, ym: ymKey(d), category: particulars || 'OTHER', amount: amt });
  }

  if (!records.length) {
    return { months: [], totals: [], categoryChart: [], grandTotal: 0 };
  }

  records.sort((a, b) => a.date - b.date);
  const months = Array.from(new Set(records.map(r => r.ym))).sort();
  const monthLabels = months.map(monthLabel);

  const byMonth = {};
  months.forEach(m => byMonth[m] = 0);
  records.forEach(r => { byMonth[r.ym] += r.amount; });
  const totals = months.map(m => Math.round(byMonth[m]));
  const grandTotal = Math.round(records.reduce((s, r) => s + r.amount, 0));

  const catTotals = {};
  records.forEach(r => { catTotals[r.category] = (catTotals[r.category] || 0) + r.amount; });
  const catEntries = Object.entries(catTotals).sort((a, b) => b[1] - a[1]);
  const topN = 6;
  const categoryChart = catEntries.slice(0, topN).map(([label, value]) => ({ label: titleCaseWords(label), value: Math.round(value) }));
  const otherSum = catEntries.slice(topN).reduce((s, [, v]) => s + v, 0);
  if (otherSum > 0) categoryChart.push({ label: 'Other', value: Math.round(otherSum) });

  return { months: monthLabels, totals, categoryChart, grandTotal };
}

module.exports = { compute, computeOpx, COLS, num, parseSheetDate };
