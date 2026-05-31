// Vercel Serverless Function: /api/market
// No external dependencies. It reads VIX, Fed rate direction and S&P 500 YTD drawdown server-side.

let memoryCache = { t: 0, data: null };
const CACHE_MS = 1000 * 60 * 5;

module.exports = async function handler(req, res) {
  try {
    const force = !!(req.query && req.query.t);
    if (!force && memoryCache.data && Date.now() - memoryCache.t < CACHE_MS) {
      res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=1800');
      return res.status(200).json({ ...memoryCache.data, cached: 'memory' });
    }

    const [vixR, rateR, ddR] = await Promise.allSettled([
      loadVix(),
      loadRate(),
      loadDrawdown()
    ]);

    const errors = [];
    const payload = {
      updatedAt: new Date().toISOString(),
      vix: vixR.status === 'fulfilled' ? vixR.value : null,
      rate: rateR.status === 'fulfilled' ? rateR.value : null,
      drawdown: ddR.status === 'fulfilled' ? ddR.value : null,
      errors
    };

    if (vixR.status === 'rejected') errors.push('VIX：' + shortErr(vixR.reason));
    if (rateR.status === 'rejected') errors.push('利率：' + shortErr(rateR.reason));
    if (ddR.status === 'rejected') errors.push('标普500回撤：' + shortErr(ddR.reason));

    memoryCache = { t: Date.now(), data: payload };

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=1800');
    return res.status(200).json(payload);
  } catch (err) {
    return res.status(500).json({ error: shortErr(err), updatedAt: new Date().toISOString() });
  }
};

function shortErr(e) {
  return String(e && (e.message || e)).slice(0, 240);
}

async function fetchText(url, timeoutMs = 8000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 market-dashboard/1.0',
        'Accept': 'text/csv,application/json,text/plain,*/*'
      }
    });
    const text = await resp.text();
    if (!resp.ok) throw new Error('HTTP ' + resp.status + ': ' + text.slice(0, 80));
    if (!text || /access denied|cloudflare|too many requests|<html/i.test(text.slice(0, 500))) {
      throw new Error('bad upstream response');
    }
    return text;
  } finally {
    clearTimeout(timer);
  }
}

async function firstSuccess(tasks) {
  const errors = [];
  for (const task of tasks) {
    try {
      return await task();
    } catch (e) {
      errors.push(shortErr(e));
    }
  }
  throw new Error(errors.join(' | '));
}

function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/).filter(Boolean);
  return lines.map(line => {
    const out = [];
    let cur = '', q = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') q = !q;
      else if (c === ',' && !q) { out.push(cur); cur = ''; }
      else cur += c;
    }
    out.push(cur);
    return out.map(x => x.trim());
  });
}

function parseStooqDaily(text) {
  const rows = parseCsv(text);
  if (rows.length < 2 || /no data/i.test(text)) throw new Error('Stooq no data');
  const header = rows[0].map(x => x.toLowerCase());
  const di = header.indexOf('date'), ci = header.indexOf('close');
  if (di < 0 || ci < 0) throw new Error('Stooq CSV missing fields');
  const arr = rows.slice(1)
    .map(r => ({ date: r[di], close: Number(r[ci]) }))
    .filter(x => x.date && Number.isFinite(x.close));
  if (!arr.length) throw new Error('no valid close');
  return arr;
}

function parseYahooChart(text) {
  const j = JSON.parse(text);
  const r = j.chart && j.chart.result && j.chart.result[0];
  if (!r) throw new Error('Yahoo no result');
  const closes = r.indicators.quote[0].close;
  const times = r.timestamp || [];
  const arr = [];
  for (let i = 0; i < closes.length; i++) {
    if (closes[i] != null && times[i]) {
      arr.push({ date: new Date(times[i] * 1000).toISOString().slice(0, 10), close: closes[i] });
    }
  }
  if (!arr.length) throw new Error('Yahoo no valid close');
  return arr;
}

function latest(arr) { return arr[arr.length - 1]; }
function pad(n) { return String(n).padStart(2, '0'); }
function ymd(d) { return d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()); }
function yahooPeriod1(d1) {
  return Math.floor(new Date(d1.slice(0, 4) + '-' + d1.slice(4, 6) + '-' + d1.slice(6, 8) + 'T00:00:00Z').getTime() / 1000);
}
function yahooPeriod2() { return Math.floor((Date.now() + 86400000) / 1000); }

async function loadMarketSeries(kind, d1, d2) {
  const tasks = [];
  if (kind === 'vix') {
    ['^vix', 'vix'].forEach(s => {
      tasks.push(async () => ({ arr: parseStooqDaily(await fetchText(`https://stooq.com/q/d/l/?s=${encodeURIComponent(s)}&d1=${d1}&d2=${d2}&i=d`)), source: 'Stooq' }));
    });
    ['query1', 'query2'].forEach(q => {
      tasks.push(async () => ({ arr: parseYahooChart(await fetchText(`https://${q}.finance.yahoo.com/v8/finance/chart/%5EVIX?period1=${yahooPeriod1(d1)}&period2=${yahooPeriod2()}&interval=1d`)), source: 'Yahoo Finance' }));
    });
  } else {
    ['^spx', 'spx', '^gspc'].forEach(s => {
      tasks.push(async () => ({ arr: parseStooqDaily(await fetchText(`https://stooq.com/q/d/l/?s=${encodeURIComponent(s)}&d1=${d1}&d2=${d2}&i=d`)), source: 'Stooq' }));
    });
    ['query1', 'query2'].forEach(q => {
      tasks.push(async () => ({ arr: parseYahooChart(await fetchText(`https://${q}.finance.yahoo.com/v8/finance/chart/%5EGSPC?period1=${yahooPeriod1(d1)}&period2=${yahooPeriod2()}&interval=1d`)), source: 'Yahoo Finance' }));
    });
  }
  return firstSuccess(tasks);
}

async function loadVix() {
  const d2 = ymd(new Date());
  const start = new Date(); start.setDate(start.getDate() - 120);
  const { arr, source } = await loadMarketSeries('vix', ymd(start), d2);
  const last = latest(arr);
  return { value: last.close, date: last.date, source };
}

function parseFred(text) {
  const rows = parseCsv(text);
  const arr = rows.slice(1)
    .map(r => ({ date: r[0], value: Number(r[1]) }))
    .filter(x => x.date && Number.isFinite(x.value));
  if (!arr.length) throw new Error('FRED no valid values');
  return arr;
}

async function loadFredSeries(id) {
  const text = await fetchText(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${id}`, 8000);
  return parseFred(text);
}

async function loadRate() {
  try {
    const [upper, lower] = await Promise.all([loadFredSeries('DFEDTARU'), loadFredSeries('DFEDTARL')]);
    const lu = latest(upper), ll = latest(lower);
    const latestMid = (lu.value + ll.value) / 2;
    const idxU = Math.max(0, upper.length - 91);
    const idxL = Math.max(0, lower.length - 91);
    const oldMid = (upper[idxU].value + lower[idxL].value) / 2;
    return { value: latestMid, date: lu.date, change: latestMid - oldMid, source: 'FRED 目标利率区间' };
  } catch (e) {
    const eff = await loadFredSeries('FEDFUNDS');
    const last = latest(eff);
    const old = eff[Math.max(0, eff.length - 4)];
    return { value: last.value, date: last.date, change: last.value - old.value, source: 'FRED FEDFUNDS' };
  }
}

async function loadDrawdown() {
  const year = new Date().getFullYear();
  const d1 = String(year) + '0101';
  const d2 = ymd(new Date());
  const { arr, source } = await loadMarketSeries('spx', d1, d2);
  let high = -Infinity, highDate = '';
  for (const x of arr) {
    if (x.close > high) { high = x.close; highDate = x.date; }
  }
  const last = latest(arr);
  return {
    value: (last.close / high - 1) * 100,
    latest: last.close,
    date: last.date,
    high,
    highDate,
    source
  };
}
