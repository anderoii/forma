// «Форма» — сервер автоперенесення даних Apple Watch (Cloudflare Worker, безплатний план).
// Команда iPhone надсилає сюди дані (POST /health), а «Форма» сама забирає їх при відкритті (GET /health).
// Потрібно: KV-сховище з назвою змінної HEALTH і секрет TOKEN (будь-який довгий пароль).
// Необов’язково: змінна TZ (часовий пояс, за замовчуванням Europe/Kyiv).

const FIELDS = ["active", "steps", "rhr", "hr", "hrv", "sleep", "wkcal", "weight"];

export default {
  async fetch(req, env) {
    const cors = {
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "content-type, x-token",
      "access-control-allow-methods": "GET, POST, OPTIONS",
    };
    if (req.method === "OPTIONS") return new Response(null, {headers: cors});
    const json = (o, status = 200) => new Response(JSON.stringify(o), {status, headers: {...cors, "content-type": "application/json; charset=utf-8"}});
    const url = new URL(req.url);

    if (!env.HEALTH) return json({error: "Не підключено KV-сховище HEALTH"}, 500);
    if (!env.TOKEN) return json({error: "Не задано секрет TOKEN"}, 500);
    const token = req.headers.get("x-token") || url.searchParams.get("token");
    if (token !== env.TOKEN) return json({error: "unauthorized"}, 401);

    // Простий спосіб для команди iPhone — усе в адресі (GET):
    // /health?token=ПАРОЛЬ&active=520&steps=8400&rhr=58
    const viaQuery = url.pathname === "/health" && req.method === "GET" && FIELDS.some(k => url.searchParams.has(k));
    if (url.pathname === "/health" && (req.method === "POST" || viaQuery)) {
      let body = {};
      if (viaQuery) body = Object.fromEntries(url.searchParams);
      else {
        const txt = await req.text();
        try { body = JSON.parse(txt); } catch (e) {
          // формат команди: active=520;steps=8400;rhr=58;sleep=7,5
          for (const m of txt.matchAll(/(active|steps|rhr|hrv|hr|sleep|wkcal|weight|date)\s*[=:]\s*([^;&\n]+)/gi)) body[m[1].toLowerCase()] = m[2].trim();
        }
      }
      const date = /^\d{4}-\d{2}-\d{2}$/.test(String(body.date || "")) ? body.date : localDate(env.TZ || "Europe/Kyiv");
      const keep = {};
      for (const k of FIELDS) {
        const v = clean(body[k], k === "steps");
        if (v !== null) keep[k] = v;
      }
      if (!Object.keys(keep).length) return json({error: "Немає даних. Очікую поля: " + FIELDS.join(", ")}, 400);
      const key = "d:" + date;
      const old = JSON.parse((await env.HEALTH.get(key)) || "{}");
      await env.HEALTH.put(key, JSON.stringify({...old, ...keep, at: Date.now()}), {expirationTtl: 400 * 86400});
      return json({ok: true, date, saved: keep});
    }

    if (url.pathname === "/health" && req.method === "GET") {
      const since = /^\d{4}-\d{2}-\d{2}$/.test(url.searchParams.get("since") || "") ? url.searchParams.get("since") : "0000";
      const days = {};
      let cursor;
      do {
        const page = await env.HEALTH.list({prefix: "d:", cursor});
        for (const k of page.keys) {
          const d = k.name.slice(2);
          if (d < since) continue;
          const v = await env.HEALTH.get(k.name);
          if (v) days[d] = JSON.parse(v);
        }
        cursor = page.list_complete ? null : page.cursor;
      } while (cursor);
      return json({days});
    }

    return json({ok: true, app: "forma-health"});
  },
};

// "8 400" → 8400, "7,5" → 7.5, "520 kcal" → 520
function clean(v, intLike) {
  if (v === undefined || v === null || v === "") return null;
  let t = String(v).replace(/[\s\u00a0\u202f]/g, "");
  // кроки: 8,400 → 8400; решта: 154,483 або 7,5 → десяткова кома
  t = intLike && /^\d{1,3}(,\d{3})+$/.test(t) ? t.replace(/,/g, "") : t.replace(",", ".");
  const s = t.match(/-?\d+(\.\d+)?/);
  if (!s) return null;
  const x = parseFloat(s[0]);
  return isFinite(x) && x >= 0 ? x : null;
}

function localDate(tz) {
  try { return new Intl.DateTimeFormat("en-CA", {timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit"}).format(new Date()); }
  catch (e) { return new Date().toISOString().slice(0, 10); }
}
