// scripts/send-reminders.js
// 讀 reminders.json，找出到期提醒，推播到 LINE。
// 設計重點：用「補發窗 + 一次性旗標」吸收 GitHub 排程的延遲，避免漏發或重複發。

const fs = require('fs');
const https = require('https');

const TOKEN = process.env.LINE_TOKEN;
const USER  = process.env.LINE_USER_ID;
const FILE  = 'reminders.json';

const GRACE_MIN   = 60;  // 到期後 N 分鐘內仍可補發（吸收排程延遲）。設大一點較保險。
const EARLY_MIN   = 15;  // 到期前 N 分鐘內送「即將到了」預告

// 缺密鑰時直接讓這次執行失敗（紅色），方便你在 Actions 列表一眼看到
if (!TOKEN || !USER) {
  console.error('❌ 缺少 LINE_TOKEN 或 LINE_USER_ID');
  console.error('   請到 repo → Settings → Secrets and variables → Actions 設定這兩個 secret');
  process.exit(1);
}

const repeatLabel = { daily: '每天', weekly: '每週', monthly: '每月', yearly: '每年' };

function fmt(r) {
  return [
    '📌 ' + r.title,
    '📅 ' + r.date + ' ' + r.time,
    r.note ? '📝 ' + r.note : '',
    (r.repeat && r.repeat !== 'none') ? '🔁 ' + (repeatLabel[r.repeat] || r.repeat) : ''
  ].filter(Boolean).join('\n');
}

// reminders.json 存的是台灣本地時間字串；統一以 +8 偏移後當 UTC 比對，兩邊一致即正確
function dueAt(r) { return new Date(r.date + 'T' + r.time + ':00Z'); }

function sendLine(text) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ to: USER, messages: [{ type: 'text', text }] });
    const req = https.request({
      hostname: 'api.line.me',
      path: '/v2/bot/message/push',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + TOKEN,
        'Content-Length': Buffer.byteLength(body)
      }
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        const ok = res.statusCode >= 200 && res.statusCode < 300;
        console.log('LINE 回應 ' + res.statusCode + (ok ? '' : ' → ' + data));
        resolve(res.statusCode);
      });
    });
    req.on('error', (e) => { console.error('送出錯誤：' + e.message); resolve(0); });
    req.write(body);
    req.end();
  });
}

// 把重複提醒往後推到「下一個尚未過太久」的時點，避免排程停擺後一次洗版
function advance(r, twNow) {
  const d = dueAt(r);
  let guard = 0;
  do {
    if (r.repeat === 'daily')        d.setUTCDate(d.getUTCDate() + 1);
    else if (r.repeat === 'weekly')  d.setUTCDate(d.getUTCDate() + 7);
    else if (r.repeat === 'monthly') d.setUTCMonth(d.getUTCMonth() + 1);
    else if (r.repeat === 'yearly')  d.setUTCFullYear(d.getUTCFullYear() + 1);
    else break;
  } while ((twNow - d) / 60000 > GRACE_MIN && ++guard < 600);
  r.date = d.toISOString().slice(0, 10);
  r.time = d.toISOString().slice(11, 16);
  r.notified = false;
  r.notifiedEarly = false;
}

(async () => {
  let reminders;
  try {
    reminders = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch (e) {
    console.log('reminders.json 讀取失敗，結束');
    return;
  }

  const twNow = new Date(Date.now() + 8 * 3600 * 1000);
  console.log('台灣現在時間 ' + twNow.toISOString().slice(0, 16).replace('T', ' '));
  console.log('提醒筆數 ' + reminders.length);

  let changed = false;

  for (const r of reminders) {
    if (r.done) continue;
    const diff = (twNow - dueAt(r)) / 60000; // 正=已過、負=未到（分鐘）
    console.log(`· ${r.title} | ${r.date} ${r.time} | diff ${diff.toFixed(1)}分`);

    // 預告：到期前 EARLY_MIN 分鐘內，只送一次
    if (diff < 0 && diff >= -EARLY_MIN && !r.notifiedEarly) {
      const code = await sendLine('⏰ 即將到了（約 ' + Math.round(-diff) + ' 分鐘後）\n\n' + fmt(r));
      if (code >= 200 && code < 300) { r.notifiedEarly = true; changed = true; }
    }

    // 到期：含補發窗，只送一次
    if (diff >= 0 && diff <= GRACE_MIN && !r.notified) {
      const code = await sendLine('🔔 提醒通知\n\n' + fmt(r));
      if (code >= 200 && code < 300) {
        r.notified = true; changed = true;
        if (!r.repeat || r.repeat === 'none') r.done = true;
        else advance(r, twNow);
        console.log('  ✓ 已發送：' + r.title);
      }
    }

    // 已逾期超過補發窗且沒發到：重複類靜默滾到下一個時點（不洗版）；一次性的就留著不動
    if (diff > GRACE_MIN && !r.notified && r.repeat && r.repeat !== 'none') {
      advance(r, twNow);
      changed = true;
      console.log('  ↻ 逾期滾動：' + r.title + ' → ' + r.date + ' ' + r.time);
    }
  }

  if (changed) {
    fs.writeFileSync(FILE, JSON.stringify(reminders, null, 2));
    console.log('reminders.json 已更新');
  } else {
    console.log('本次無須變更');
  }
})();
