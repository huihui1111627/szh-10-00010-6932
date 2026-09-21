// 机场冬季运行协同推演 —— 后端服务（零依赖，Node 内置模块）
// 职责：静态资源 + 处置方案的真实执行进度持久化（刷新/重启不回退）
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSim, defaultScenario } from './public/js/engine.js';
import { newPlanDoc, advanceAndRecompute } from './public/js/state.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'plans.json');
const PORT = process.env.PORT || 4173;

fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, '{"plans":{}}');

function readDB() {
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
  catch { return { plans: {} }; }
}
function writeDB(db) {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

function send(res, code, body, type = 'application/json; charset=utf-8') {
  res.writeHead(code, { 'Content-Type': type });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 5e6) reject(new Error('body too large')); });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
  });
}

// 落库前剥离可再生成的推演结果，保留真实执行字段
function toStored(doc) {
  return {
    id: doc.id, name: doc.name, scenario: doc.scenario, now: doc.now,
    speed: doc.speed, locks: doc.locks, createdAt: doc.createdAt, updatedAt: doc.updatedAt,
  };
}
function fromStored(stored) {
  const doc = { ...newPlanDoc(stored.name), ...stored, playing: false };
  if (!doc.scenario) doc.scenario = defaultScenario();
  doc.sim = runSim(doc.scenario, doc.locks || {});
  return doc;
}

async function handler(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const { pathname } = url;

  // ---- API ----
  if (pathname.startsWith('/api/')) {
    try {
      const db = readDB();

      if (pathname === '/api/plans' && req.method === 'GET') {
        const list = Object.values(db.plans)
          .map(fromStored)
          .sort((a, b) => b.updatedAt - a.updatedAt)
          .map(d => ({ id: d.id, name: d.name, now: d.now, updatedAt: d.updatedAt,
            highAlerts: d.sim.summary.highAlerts, medAlerts: d.sim.summary.medAlerts,
            summary: d.sim.summary }));
        return send(res, 200, { plans: list });
      }

      if (pathname === '/api/plans' && req.method === 'POST') {
        const body = await readBody(req);
        const doc = newPlanDoc(body.name || '处置方案');
        doc.scenario = body.scenario || defaultScenario();
        doc.sim = runSim(doc.scenario);
        db.plans[doc.id] = toStored(doc);
        writeDB(db);
        return send(res, 200, { doc: fromStored(db.plans[doc.id]) });
      }

      const m = pathname.match(/^\/api\/plans\/([A-Za-z0-9_]+)(\/(clone|reset|tick))?$/);
      if (m) {
        const [, id, , action] = m;
        if (req.method === 'GET' && !action) {
          const stored = db.plans[id];
          if (!stored) return send(res, 404, { error: '方案不存在' });
          return send(res, 200, { doc: fromStored(stored) });
        }
        if (req.method === 'DELETE' && !action) {
          delete db.plans[id];
          writeDB(db);
          return send(res, 200, { ok: true });
        }
        if (req.method === 'POST') {
          const stored = db.plans[id];
          if (!stored) return send(res, 404, { error: '方案不存在' });
          const body = await readBody(req);
          const doc = fromStored(stored);

          if (action === 'tick') {
            // 推进真实执行时钟并重推演（已发生的一切被锁定）
            const target = Math.min(240, Math.max(doc.now, Number(body.now) ?? doc.now + 1));
            doc.now = target;
            doc.speed = Number(body.speed) || doc.speed;
            advanceAndRecompute(doc);
            db.plans[id] = toStored(doc);
            writeDB(db);
            return send(res, 200, { doc: fromStored(db.plans[id]) });
          }
          if (action === 'reset') {
            delete db.plans[id];
            writeDB(db);
            return send(res, 200, { ok: true });
          }
          if (action === 'clone') {
            const copy = JSON.parse(JSON.stringify(toStored(doc)));
            copy.id = 'plan_' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36);
            copy.name = (body.name || doc.name) + '（副本）';
            db.plans[copy.id] = copy;
            writeDB(db);
            return send(res, 200, { doc: fromStored(copy) });
          }

          // 人工调整：场景参数（仅允许改动未执行部分）/ 重命名
          if (body.name) doc.name = String(body.name).slice(0, 40);
          if (body.scenario) {
            doc.scenario = body.scenario;
            advanceAndRecompute(doc);
          }
          db.plans[id] = toStored(doc);
          writeDB(db);
          return send(res, 200, { doc: fromStored(db.plans[id]) });
        }
      }
      return send(res, 404, { error: '未知接口' });
    } catch (e) {
      return send(res, 500, { error: String(e && e.message || e) });
    }
  }

  // ---- 静态资源 ----
  let rel = pathname === '/' ? '/index.html' : pathname;
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC)) return send(res, 403, 'forbidden', 'text/plain');
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, 'not found', 'text/plain');
    send(res, 200, buf, MIME[path.extname(file)] || 'application/octet-stream');
  });
}

http.createServer(handler).listen(PORT, () => {
  console.log(`机场冬季运行协同推演系统: http://localhost:${PORT}`);
});
