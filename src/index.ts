/**
 * Echo Live Chat v1.0.0 — Intercom/Drift Alternative
 * Embeddable AI-powered chat widgets for websites
 * Multi-tenant, real-time conversations, AI fallback, visitor tracking
 */

interface Env {
  DB: D1Database;
  CACHE: KVNamespace;
  ENGINE_RUNTIME: Fetcher;
  SHARED_BRAIN: Fetcher;
  ECHO_API_KEY: string;
}

interface RLState { c: number; t: number }

function sanitize(s: string, max = 2000): string {
  return s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '').slice(0, max);
}

function uid(): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 16);
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' , 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'X-XSS-Protection': '1; mode=block', 'Referrer-Policy': 'strict-origin-when-cross-origin', 'Permissions-Policy': 'camera=(), microphone=(), geolocation=()', 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains' } });
}

function err(msg: string, status = 400): Response {
  return json({ ok: false, error: msg }, status);
}

function slog(level: 'info' | 'warn' | 'error', msg: string, data?: Record<string, unknown>) {
  const entry = { ts: new Date().toISOString(), level, worker: 'echo-live-chat', version: '1.0.0', msg, ...data };
  if (level === 'error') console.error(JSON.stringify(entry));
  else console.log(JSON.stringify(entry));
}

async function rateLimit(kv: KVNamespace, key: string, max: number, windowSec = 60): Promise<boolean> {
  const now = Date.now();
  const raw = await kv.get(key);
  let state: RLState = raw ? JSON.parse(raw) : { c: 0, t: now };
  const elapsed = (now - state.t) / 1000;
  const decay = Math.max(0, state.c - (elapsed / windowSec) * max);
  if (decay + 1 > max) return false;
  await kv.put(key, JSON.stringify({ c: decay + 1, t: now } as RLState), { expirationTtl: windowSec * 2 });
  return true;
}

function getTenant(req: Request): string {
  return req.headers.get('X-Tenant-ID') || new URL(req.url).searchParams.get('tenant_id') || '';
}

function authOk(req: Request, env: Env): boolean {
  if (!env.ECHO_API_KEY) return false; // Deny all if key not configured
  const apiKey = req.headers.get('X-Echo-API-Key');
  if (apiKey && apiKey === env.ECHO_API_KEY) return true;
  const authHeader = req.headers.get('Authorization') || '';
  if (authHeader.startsWith('Bearer ') && authHeader.slice(7) === env.ECHO_API_KEY) return true;
  return false;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (req.method === 'OPTIONS') return json({ ok: true });

    try {
      const url = new URL(req.url);
      const path = url.pathname;
      const method = req.method;

    // Public endpoints — no auth
    if (path === '/health') return json({ ok: true, service: 'echo-live-chat', version: '1.0.0' });
    if (path === '/status') {
      const r = await env.DB.prepare('SELECT COUNT(*) as c FROM tenants').first<{c:number}>();
      return json({ ok: true, tenants: r?.c || 0, version: '1.0.0' });
    }

    // Widget embed script — public, CORS
    if (path === '/widget.js' && method === 'GET') {
      const widgetId = url.searchParams.get('id');
      if (!widgetId) return err('Missing widget id');
      const w = await env.DB.prepare('SELECT * FROM widgets WHERE id = ?').bind(widgetId).first();
      if (!w) return err('Widget not found', 404);
      const script = generateWidgetScript(w as Record<string, unknown>);
      return new Response(script, { headers: { 'Content-Type': 'application/javascript', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=300' } });
    }

    // Public visitor-facing chat API — rate limited per visitor
    if (path.startsWith('/v/')) return handleVisitorAPI(req, env, path, method);

    // Rate limit write endpoints
    if (method !== 'GET') {
      const rlKey = `rl:${getTenant(req) || req.headers.get('CF-Connecting-IP') || 'anon'}`;
      if (!await rateLimit(env.CACHE, rlKey, 60)) return err('Rate limited', 429);
    }

    // Auth required for management endpoints
    if (!authOk(req, env)) return err('Unauthorized', 401);

    const tid = getTenant(req);

      // ── Tenants ──
      if (path === '/tenants' && method === 'POST') {
        const b = await req.json() as Record<string, unknown>;
        const id = uid();
        await env.DB.prepare('INSERT INTO tenants (id, name, domain) VALUES (?, ?, ?)').bind(id, sanitize(String(b.name || ''), 200), sanitize(String(b.domain || ''), 200)).run();
        // Auto-create default widget
        const wid = uid();
        await env.DB.prepare('INSERT INTO widgets (id, tenant_id) VALUES (?, ?)').bind(wid, id).run();
        return json({ ok: true, id, widget_id: wid });
      }
      if (path === '/tenants/me' && method === 'GET') {
        const t = await env.DB.prepare('SELECT * FROM tenants WHERE id = ?').bind(tid).first();
        return t ? json(t) : err('Tenant not found', 404);
      }

      // ── Agents ──
      if (path === '/agents' && method === 'GET') {
        const rows = await env.DB.prepare('SELECT * FROM agents WHERE tenant_id = ? ORDER BY created_at').bind(tid).all();
        return json(rows.results);
      }
      if (path === '/agents' && method === 'POST') {
        const b = await req.json() as Record<string, unknown>;
        const id = uid();
        await env.DB.prepare('INSERT INTO agents (id, tenant_id, name, email, role) VALUES (?, ?, ?, ?, ?) ON CONFLICT(tenant_id, email) DO UPDATE SET name=excluded.name, role=excluded.role').bind(id, tid, sanitize(String(b.name || ''), 100), sanitize(String(b.email || ''), 200), sanitize(String(b.role || 'agent'), 20)).run();
        return json({ ok: true, id });
      }
      if (path.startsWith('/agents/') && method === 'PUT') {
        const aid = path.split('/')[2];
        const b = await req.json() as Record<string, unknown>;
        const fields: string[] = []; const vals: unknown[] = [];
        if (b.name) { fields.push('name = ?'); vals.push(sanitize(String(b.name), 100)); }
        if (b.status) { fields.push('status = ?'); vals.push(sanitize(String(b.status), 20)); }
        if (b.role) { fields.push('role = ?'); vals.push(sanitize(String(b.role), 20)); }
        if (b.max_concurrent !== undefined) { fields.push('max_concurrent = ?'); vals.push(Number(b.max_concurrent)); }
        if (!fields.length) return err('No fields to update');
        vals.push(aid, tid);
        await env.DB.prepare(`UPDATE agents SET ${fields.join(', ')} WHERE id = ? AND tenant_id = ?`).bind(...vals).run();
        return json({ ok: true });
      }
      if (path.startsWith('/agents/') && path.endsWith('/status') && method === 'PUT') {
        const aid = path.split('/')[2];
        const b = await req.json() as Record<string, unknown>;
        await env.DB.prepare('UPDATE agents SET status = ? WHERE id = ? AND tenant_id = ?').bind(sanitize(String(b.status || 'offline'), 20), aid, tid).run();
        return json({ ok: true });
      }
      if (path.startsWith('/agents/') && method === 'DELETE') {
        const aid = path.split('/')[2];
        await env.DB.prepare('DELETE FROM agents WHERE id = ? AND tenant_id = ?').bind(aid, tid).run();
        return json({ ok: true });
      }

      // ── Widgets ──
      if (path === '/widgets' && method === 'GET') {
        const rows = await env.DB.prepare('SELECT * FROM widgets WHERE tenant_id = ?').bind(tid).all();
        return json(rows.results);
      }
      if (path === '/widgets' && method === 'POST') {
        const b = await req.json() as Record<string, unknown>;
        const cnt = await env.DB.prepare('SELECT COUNT(*) as c FROM widgets WHERE tenant_id = ?').bind(tid).first<{c:number}>();
        const tenant = await env.DB.prepare('SELECT max_widgets FROM tenants WHERE id = ?').bind(tid).first<{max_widgets:number}>();
        if ((cnt?.c || 0) >= (tenant?.max_widgets || 1)) return err('Widget limit reached');
        const id = uid();
        await env.DB.prepare('INSERT INTO widgets (id, tenant_id, name, primary_color, greeting, position) VALUES (?, ?, ?, ?, ?, ?)').bind(id, tid, sanitize(String(b.name || 'Widget'), 100), sanitize(String(b.primary_color || '#14b8a6'), 10), sanitize(String(b.greeting || 'Hi! How can we help?'), 500), sanitize(String(b.position || 'bottom-right'), 20)).run();
        return json({ ok: true, id });
      }
      if (path.startsWith('/widgets/') && method === 'PUT') {
        const wid = path.split('/')[2];
        const b = await req.json() as Record<string, unknown>;
        const fields: string[] = []; const vals: unknown[] = [];
        for (const [k, v] of Object.entries(b)) {
          if (['name','position','primary_color','greeting','offline_message','allowed_domains','business_hours','ai_engine_id','ai_system_prompt'].includes(k)) { fields.push(`${k} = ?`); vals.push(sanitize(String(v), 2000)); }
          if (['collect_email','collect_name','show_branding','ai_fallback'].includes(k)) { fields.push(`${k} = ?`); vals.push(v ? 1 : 0); }
          if (k === 'auto_open_delay') { fields.push('auto_open_delay = ?'); vals.push(Math.min(Number(v), 120)); }
        }
        if (!fields.length) return err('No fields');
        vals.push(wid, tid);
        await env.DB.prepare(`UPDATE widgets SET ${fields.join(', ')} WHERE id = ? AND tenant_id = ?`).bind(...vals).run();
        return json({ ok: true });
      }
      if (path.startsWith('/widgets/') && path.endsWith('/embed') && method === 'GET') {
        const wid = path.split('/')[2];
        const w = await env.DB.prepare('SELECT * FROM widgets WHERE id = ? AND tenant_id = ?').bind(wid, tid).first();
        if (!w) return err('Widget not found', 404);
        const snippet = `<script src="https://echo-live-chat.bmcii1976.workers.dev/widget.js?id=${wid}" async></script>`;
        return json({ ok: true, snippet, widget: w });
      }

      // ── Conversations ──
      if (path === '/conversations' && method === 'GET') {
        const status = url.searchParams.get('status');
        const agentId = url.searchParams.get('agent_id');
        const limit = Math.min(Number(url.searchParams.get('limit') || 50), 100);
        let q = 'SELECT c.*, v.name as visitor_name, v.email as visitor_email, a.name as agent_name FROM conversations c LEFT JOIN visitors v ON c.visitor_id = v.id LEFT JOIN agents a ON c.assigned_agent_id = a.id WHERE c.tenant_id = ?';
        const params: unknown[] = [tid];
        if (status) { q += ' AND c.status = ?'; params.push(status); }
        if (agentId) { q += ' AND c.assigned_agent_id = ?'; params.push(agentId); }
        q += ' ORDER BY c.last_message_at DESC LIMIT ?';
        params.push(limit);
        const rows = await env.DB.prepare(q).bind(...params).all();
        return json(rows.results);
      }
      if (path.startsWith('/conversations/') && !path.includes('/messages') && !path.includes('/assign') && !path.includes('/close') && !path.includes('/rate') && method === 'GET') {
        const cid = path.split('/')[2];
        const conv = await env.DB.prepare('SELECT c.*, v.name as visitor_name, v.email as visitor_email, v.page_url, v.country, v.city, v.custom_data, a.name as agent_name FROM conversations c LEFT JOIN visitors v ON c.visitor_id = v.id LEFT JOIN agents a ON c.assigned_agent_id = a.id WHERE c.id = ? AND c.tenant_id = ?').bind(cid, tid).first();
        return conv ? json(conv) : err('Not found', 404);
      }

      // ── Messages (agent side) ──
      if (path.match(/^\/conversations\/[^/]+\/messages$/) && method === 'GET') {
        const cid = path.split('/')[2];
        const rows = await env.DB.prepare('SELECT * FROM messages WHERE conversation_id = ? AND tenant_id = ? ORDER BY created_at ASC LIMIT 200').bind(cid, tid).all();
        return json(rows.results);
      }
      if (path.match(/^\/conversations\/[^/]+\/messages$/) && method === 'POST') {
        const cid = path.split('/')[2];
        const b = await req.json() as Record<string, unknown>;
        const id = uid();
        await env.DB.prepare('INSERT INTO messages (id, conversation_id, tenant_id, sender_type, sender_id, sender_name, content, content_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').bind(id, cid, tid, 'agent', sanitize(String(b.agent_id || ''), 50), sanitize(String(b.agent_name || 'Agent'), 100), sanitize(String(b.content || ''), 5000), sanitize(String(b.content_type || 'text'), 20)).run();
        await env.DB.prepare('UPDATE conversations SET last_message_at = datetime(\'now\'), status = \'active\' WHERE id = ? AND tenant_id = ?').bind(cid, tid).run();
        return json({ ok: true, id });
      }

      // ── Assign / Close / Rate ──
      if (path.match(/^\/conversations\/[^/]+\/assign$/) && method === 'POST') {
        const cid = path.split('/')[2];
        const b = await req.json() as Record<string, unknown>;
        await env.DB.prepare('UPDATE conversations SET assigned_agent_id = ?, status = \'active\' WHERE id = ? AND tenant_id = ?').bind(sanitize(String(b.agent_id || ''), 50), cid, tid).run();
        return json({ ok: true });
      }
      if (path.match(/^\/conversations\/[^/]+\/close$/) && method === 'POST') {
        const cid = path.split('/')[2];
        const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
        await env.DB.prepare('UPDATE conversations SET status = \'closed\', closed_at = datetime(\'now\'), resolved_by = ? WHERE id = ? AND tenant_id = ?').bind(sanitize(String(b.resolved_by || 'agent'), 50), cid, tid).run();
        return json({ ok: true });
      }

      // ── Canned Responses ──
      if (path === '/canned' && method === 'GET') {
        const rows = await env.DB.prepare('SELECT * FROM canned_responses WHERE tenant_id = ? ORDER BY use_count DESC').bind(tid).all();
        return json(rows.results);
      }
      if (path === '/canned' && method === 'POST') {
        const b = await req.json() as Record<string, unknown>;
        const id = uid();
        await env.DB.prepare('INSERT INTO canned_responses (id, tenant_id, shortcut, title, content, category) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(tenant_id, shortcut) DO UPDATE SET title=excluded.title, content=excluded.content, category=excluded.category').bind(id, tid, sanitize(String(b.shortcut || ''), 50), sanitize(String(b.title || ''), 200), sanitize(String(b.content || ''), 5000), sanitize(String(b.category || 'general'), 50)).run();
        return json({ ok: true, id });
      }
      if (path.startsWith('/canned/') && method === 'DELETE') {
        const cid = path.split('/')[2];
        await env.DB.prepare('DELETE FROM canned_responses WHERE id = ? AND tenant_id = ?').bind(cid, tid).run();
        return json({ ok: true });
      }

      // ── Triggers ──
      if (path === '/triggers' && method === 'GET') {
        const rows = await env.DB.prepare('SELECT * FROM triggers WHERE tenant_id = ? ORDER BY created_at DESC').bind(tid).all();
        return json(rows.results);
      }
      if (path === '/triggers' && method === 'POST') {
        const b = await req.json() as Record<string, unknown>;
        const id = uid();
        await env.DB.prepare('INSERT INTO triggers (id, tenant_id, name, event, conditions, actions) VALUES (?, ?, ?, ?, ?, ?)').bind(id, tid, sanitize(String(b.name || ''), 200), sanitize(String(b.event || ''), 50), JSON.stringify(b.conditions || {}), JSON.stringify(b.actions || [])).run();
        return json({ ok: true, id });
      }
      if (path.startsWith('/triggers/') && method === 'DELETE') {
        const trid = path.split('/')[2];
        await env.DB.prepare('DELETE FROM triggers WHERE id = ? AND tenant_id = ?').bind(trid, tid).run();
        return json({ ok: true });
      }

      // ── Tags ──
      if (path === '/tags' && method === 'GET') {
        const rows = await env.DB.prepare('SELECT * FROM tags WHERE tenant_id = ? ORDER BY use_count DESC').bind(tid).all();
        return json(rows.results);
      }
      if (path === '/tags' && method === 'POST') {
        const b = await req.json() as Record<string, unknown>;
        const id = uid();
        await env.DB.prepare('INSERT INTO tags (id, tenant_id, name, color) VALUES (?, ?, ?, ?) ON CONFLICT(tenant_id, name) DO UPDATE SET color=excluded.color').bind(id, tid, sanitize(String(b.name || ''), 50), sanitize(String(b.color || '#6b7280'), 10)).run();
        return json({ ok: true, id });
      }

      // ── Visitors ──
      if (path === '/visitors' && method === 'GET') {
        const limit = Math.min(Number(url.searchParams.get('limit') || 50), 100);
        const search = url.searchParams.get('search');
        let q = 'SELECT * FROM visitors WHERE tenant_id = ?';
        const params: unknown[] = [tid];
        if (search) { q += ' AND (name LIKE ? OR email LIKE ?)'; params.push(`%${search}%`, `%${search}%`); }
        q += ' ORDER BY last_seen DESC LIMIT ?';
        params.push(limit);
        const rows = await env.DB.prepare(q).bind(...params).all();
        return json(rows.results);
      }
      if (path.startsWith('/visitors/') && method === 'GET') {
        const vid = path.split('/')[2];
        const v = await env.DB.prepare('SELECT * FROM visitors WHERE id = ? AND tenant_id = ?').bind(vid, tid).first();
        if (!v) return err('Not found', 404);
        const convos = await env.DB.prepare('SELECT id, status, started_at, last_message_at FROM conversations WHERE visitor_id = ? AND tenant_id = ? ORDER BY started_at DESC LIMIT 20').bind(vid, tid).all();
        return json({ ...v as object, conversations: convos.results });
      }

      // ── Analytics ──
      if (path === '/analytics/overview' && method === 'GET') {
        const [convos, msgs, visitors, agents, openConvos, avgRating] = await Promise.all([
          env.DB.prepare('SELECT COUNT(*) as c FROM conversations WHERE tenant_id = ?').bind(tid).first<{c:number}>(),
          env.DB.prepare('SELECT COUNT(*) as c FROM messages WHERE tenant_id = ?').bind(tid).first<{c:number}>(),
          env.DB.prepare('SELECT COUNT(*) as c FROM visitors WHERE tenant_id = ?').bind(tid).first<{c:number}>(),
          env.DB.prepare('SELECT COUNT(*) as c FROM agents WHERE tenant_id = ?').bind(tid).first<{c:number}>(),
          env.DB.prepare('SELECT COUNT(*) as c FROM conversations WHERE tenant_id = ? AND status IN (\'open\', \'active\')').bind(tid).first<{c:number}>(),
          env.DB.prepare('SELECT AVG(rating) as avg FROM conversations WHERE tenant_id = ? AND rating IS NOT NULL').bind(tid).first<{avg:number|null}>(),
        ]);
        return json({ total_conversations: convos?.c || 0, total_messages: msgs?.c || 0, total_visitors: visitors?.c || 0, total_agents: agents?.c || 0, open_conversations: openConvos?.c || 0, avg_rating: avgRating?.avg || null });
      }
      if (path === '/analytics/daily' && method === 'GET') {
        const days = Math.min(Number(url.searchParams.get('days') || 30), 90);
        const rows = await env.DB.prepare('SELECT * FROM analytics_daily WHERE tenant_id = ? AND date >= date(\'now\', \'-\' || ? || \' days\') ORDER BY date ASC').bind(tid, days).all();
        return json(rows.results);
      }
      if (path === '/analytics/agents' && method === 'GET') {
        const rows = await env.DB.prepare(`
          SELECT a.id, a.name, a.status,
            (SELECT COUNT(*) FROM conversations WHERE assigned_agent_id = a.id AND status IN ('open','active')) as active_conversations,
            (SELECT COUNT(*) FROM conversations WHERE assigned_agent_id = a.id) as total_conversations,
            (SELECT AVG(rating) FROM conversations WHERE assigned_agent_id = a.id AND rating IS NOT NULL) as avg_rating
          FROM agents a WHERE a.tenant_id = ?
        `).bind(tid).all();
        return json(rows.results);
      }

      // ── AI ──
      if (path === '/ai/suggest-reply' && method === 'POST') {
        const b = await req.json() as Record<string, unknown>;
        try {
          const resp = await env.ENGINE_RUNTIME.fetch('https://engine/query', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ engine_id: 'GEN-01', query: `You are a customer support agent. Suggest a helpful reply to this customer message: "${sanitize(String(b.message || ''), 1000)}". Context: ${sanitize(String(b.context || ''), 2000)}. Keep the reply professional, concise, and helpful.` }) });
          const data = await resp.json() as Record<string, unknown>;
          return json({ ok: true, suggestion: data.answer || data.response || 'I would be happy to help you with that.' });
        } catch (e) {
          slog('warn', 'AI suggest reply failed', { error: e instanceof Error ? e.message : String(e) });
          return json({ ok: true, suggestion: 'Thank you for reaching out. Let me look into this for you.' });
        }
      }
      if (path === '/ai/auto-tag' && method === 'POST') {
        const b = await req.json() as Record<string, unknown>;
        try {
          const resp = await env.ENGINE_RUNTIME.fetch('https://engine/query', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ engine_id: 'GEN-01', query: `Analyze this customer conversation and suggest 2-4 tags: "${sanitize(String(b.messages || ''), 3000)}". Return ONLY a JSON array of tag strings.` }) });
          const data = await resp.json() as Record<string, unknown>;
          const answer = String(data.answer || data.response || '[]');
          const match = answer.match(/\[.*?\]/s);
          return json({ ok: true, tags: match ? JSON.parse(match[0]) : ['support'] });
        } catch (e) {
          slog('warn', 'AI auto-tag failed', { error: e instanceof Error ? e.message : String(e) });
          return json({ ok: true, tags: ['support'] });
        }
      }

      return err('Not found', 404);
    } catch (e: unknown) {
      if ((e as Error).message?.includes('JSON')) {
        return err('Invalid JSON body', 400);
      }
      slog('error', 'Unhandled request error', { error: (e as Error).message, stack: (e as Error).stack });
      return err('Internal server error', 500);
    }
  },

  async scheduled(_event: ScheduledEvent, env: Env): Promise<void> {
    // Daily analytics aggregation
    const today = new Date().toISOString().split('T')[0];
    const tenants = await env.DB.prepare('SELECT id FROM tenants').all();
    for (const t of tenants.results) {
      const tid = (t as { id: string }).id;
      const [started, resolved, sent, received, ai, visitors] = await Promise.all([
        env.DB.prepare('SELECT COUNT(*) as c FROM conversations WHERE tenant_id = ? AND date(started_at) = ?').bind(tid, today).first<{c:number}>(),
        env.DB.prepare('SELECT COUNT(*) as c FROM conversations WHERE tenant_id = ? AND date(closed_at) = ?').bind(tid, today).first<{c:number}>(),
        env.DB.prepare('SELECT COUNT(*) as c FROM messages WHERE tenant_id = ? AND sender_type = \'agent\' AND date(created_at) = ?').bind(tid, today).first<{c:number}>(),
        env.DB.prepare('SELECT COUNT(*) as c FROM messages WHERE tenant_id = ? AND sender_type = \'visitor\' AND date(created_at) = ?').bind(tid, today).first<{c:number}>(),
        env.DB.prepare('SELECT COUNT(*) as c FROM messages WHERE tenant_id = ? AND ai_generated = 1 AND date(created_at) = ?').bind(tid, today).first<{c:number}>(),
        env.DB.prepare('SELECT COUNT(DISTINCT visitor_id) as c FROM conversations WHERE tenant_id = ? AND date(started_at) = ?').bind(tid, today).first<{c:number}>(),
      ]);
      await env.DB.prepare('INSERT INTO analytics_daily (tenant_id, date, conversations_started, conversations_resolved, messages_sent, messages_received, ai_responses, unique_visitors) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(tenant_id, date) DO UPDATE SET conversations_started=excluded.conversations_started, conversations_resolved=excluded.conversations_resolved, messages_sent=excluded.messages_sent, messages_received=excluded.messages_received, ai_responses=excluded.ai_responses, unique_visitors=excluded.unique_visitors').bind(tid, today, started?.c||0, resolved?.c||0, sent?.c||0, received?.c||0, ai?.c||0, visitors?.c||0).run();
    }
    // Cleanup old activity logs
    await env.DB.prepare('DELETE FROM activity_log WHERE created_at < datetime(\'now\', \'-30 days\')').run();
  },
};

// ── Visitor-facing public API ──
async function handleVisitorAPI(req: Request, env: Env, path: string, method: string): Promise<Response> {
  // Rate limit visitors more aggressively
  const ip = req.headers.get('CF-Connecting-IP') || 'anon';
  if (method !== 'GET') {
    if (!await rateLimit(env.CACHE, `vrl:${ip}`, 30)) return err('Rate limited', 429);
  }

  // POST /v/init — Initialize chat session
  if (path === '/v/init' && method === 'POST') {
    const b = await req.json() as Record<string, unknown>;
    const widgetId = sanitize(String(b.widget_id || ''), 50);
    const w = await env.DB.prepare('SELECT * FROM widgets WHERE id = ?').bind(widgetId).first() as Record<string, unknown> | null;
    if (!w) return err('Widget not found', 404);
    const tid = String(w.tenant_id);

    // Check domain allowlist
    const origin = req.headers.get('Origin') || '';
    if (w.allowed_domains) {
      const allowed = String(w.allowed_domains).split(',').map(d => d.trim().toLowerCase());
      const originHost = origin ? new URL(origin).hostname.toLowerCase() : '';
      if (allowed.length > 0 && allowed[0] !== '' && !allowed.some(d => originHost.endsWith(d))) {
        return err('Domain not allowed', 403);
      }
    }

    // Create or update visitor
    const vid = uid();
    await env.DB.prepare('INSERT INTO visitors (id, tenant_id, widget_id, name, email, ip_address, user_agent, page_url, referrer) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').bind(vid, tid, widgetId, sanitize(String(b.name || ''), 100), sanitize(String(b.email || ''), 200), ip, sanitize(String(b.user_agent || '').slice(0, 300), 300), sanitize(String(b.page_url || ''), 500), sanitize(String(b.referrer || ''), 500)).run();

    // Create conversation
    const cid = uid();
    await env.DB.prepare('INSERT INTO conversations (id, tenant_id, widget_id, visitor_id) VALUES (?, ?, ?, ?)').bind(cid, tid, widgetId, vid).run();

    // Check for online agents
    const onlineAgent = await env.DB.prepare('SELECT id, name FROM agents WHERE tenant_id = ? AND status = \'online\' AND auto_assign = 1 ORDER BY (SELECT COUNT(*) FROM conversations WHERE assigned_agent_id = agents.id AND status IN (\'open\',\'active\')) ASC LIMIT 1').bind(tid).first();
    if (onlineAgent) {
      await env.DB.prepare('UPDATE conversations SET assigned_agent_id = ?, status = \'active\' WHERE id = ?').bind((onlineAgent as {id:string}).id, cid).run();
    }

    return json({
      ok: true,
      conversation_id: cid,
      visitor_id: vid,
      widget: { greeting: w.greeting, primary_color: w.primary_color, position: w.position, collect_email: w.collect_email, collect_name: w.collect_name, show_branding: w.show_branding },
      agent_online: !!onlineAgent,
      agent_name: onlineAgent ? (onlineAgent as {name:string}).name : null,
    });
  }

  // POST /v/message — Visitor sends a message
  if (path === '/v/message' && method === 'POST') {
    const b = await req.json() as Record<string, unknown>;
    const cid = sanitize(String(b.conversation_id || ''), 50);
    const vid = sanitize(String(b.visitor_id || ''), 50);
    const content = sanitize(String(b.content || ''), 5000);
    if (!cid || !content) return err('Missing conversation_id or content');

    const conv = await env.DB.prepare('SELECT * FROM conversations WHERE id = ?').bind(cid).first() as Record<string, unknown> | null;
    if (!conv) return err('Conversation not found', 404);
    const tid = String(conv.tenant_id);

    // Save visitor message
    const mid = uid();
    await env.DB.prepare('INSERT INTO messages (id, conversation_id, tenant_id, sender_type, sender_id, sender_name, content) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(mid, cid, tid, 'visitor', vid, sanitize(String(b.visitor_name || 'Visitor'), 100), content).run();
    await env.DB.prepare('UPDATE conversations SET last_message_at = datetime(\'now\') WHERE id = ?').bind(cid).run();

    // If no agent assigned and AI fallback enabled, generate AI response
    const widget = await env.DB.prepare('SELECT ai_fallback, ai_engine_id, ai_system_prompt FROM widgets WHERE id = ?').bind(String(conv.widget_id)).first() as Record<string, unknown> | null;
    let aiReply: string | null = null;

    if (widget && widget.ai_fallback && !conv.assigned_agent_id) {
      try {
        const sysPrompt = widget.ai_system_prompt ? String(widget.ai_system_prompt) : 'You are a helpful customer support assistant. Be concise, friendly, and professional.';
        // Get recent messages for context
        const recent = await env.DB.prepare('SELECT sender_type, content FROM messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 5').bind(cid).all();
        const history = recent.results.reverse().map((m: Record<string, unknown>) => `${m.sender_type === 'visitor' ? 'Customer' : 'Agent'}: ${m.content}`).join('\n');

        const resp = await env.ENGINE_RUNTIME.fetch('https://engine/query', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ engine_id: String(widget.ai_engine_id || 'GEN-01'), query: `${sysPrompt}\n\nConversation:\n${history}\n\nRespond helpfully and concisely.` }),
        });
        const data = await resp.json() as Record<string, unknown>;
        aiReply = String(data.answer || data.response || '');
        if (aiReply) {
          const aiMid = uid();
          await env.DB.prepare('INSERT INTO messages (id, conversation_id, tenant_id, sender_type, sender_name, content, ai_generated) VALUES (?, ?, ?, ?, ?, ?, 1)').bind(aiMid, cid, tid, 'bot', 'AI Assistant', aiReply).run();
        }
      } catch (e) { console.warn(JSON.stringify({ ts: new Date().toISOString(), level: 'warn', worker: 'echo-live-chat', message: 'AI auto-reply fallback failed', error: (e as Error)?.message })); }
    }

    return json({ ok: true, message_id: mid, ai_reply: aiReply });
  }

  // GET /v/messages — Visitor polls for new messages
  if (path === '/v/messages' && method === 'GET') {
    const url = new URL(req.url);
    const cid = url.searchParams.get('conversation_id') || '';
    const after = url.searchParams.get('after') || '';
    if (!cid) return err('Missing conversation_id');
    let q = 'SELECT id, sender_type, sender_name, content, content_type, ai_generated, created_at FROM messages WHERE conversation_id = ?';
    const params: unknown[] = [cid];
    if (after) { q += ' AND created_at > ?'; params.push(after); }
    q += ' ORDER BY created_at ASC LIMIT 50';
    const rows = await env.DB.prepare(q).bind(...params).all();
    return json(rows.results);
  }

  // POST /v/rate — Visitor rates conversation
  if (path === '/v/rate' && method === 'POST') {
    const b = await req.json() as Record<string, unknown>;
    const cid = sanitize(String(b.conversation_id || ''), 50);
    const rating = Math.min(5, Math.max(1, Number(b.rating || 5)));
    await env.DB.prepare('UPDATE conversations SET rating = ?, feedback = ? WHERE id = ?').bind(rating, sanitize(String(b.feedback || ''), 1000), cid).run();
    return json({ ok: true });
  }

  // POST /v/visitor — Update visitor info
  if (path === '/v/visitor' && method === 'POST') {
    const b = await req.json() as Record<string, unknown>;
    const vid = sanitize(String(b.visitor_id || ''), 50);
    const fields: string[] = []; const vals: unknown[] = [];
    if (b.name) { fields.push('name = ?'); vals.push(sanitize(String(b.name), 100)); }
    if (b.email) { fields.push('email = ?'); vals.push(sanitize(String(b.email), 200)); }
    if (b.custom_data) { fields.push('custom_data = ?'); vals.push(JSON.stringify(b.custom_data).slice(0, 5000)); }
    if (!fields.length) return err('No fields');
    fields.push('last_seen = datetime(\'now\')');
    vals.push(vid);
    await env.DB.prepare(`UPDATE visitors SET ${fields.join(', ')} WHERE id = ?`).bind(...vals).run();
    return json({ ok: true });
  }

  return err('Not found', 404);
}

// ── Widget Embed Script Generator ──
function generateWidgetScript(w: Record<string, unknown>): string {
  const color = String(w.primary_color || '#14b8a6');
  const position = String(w.position || 'bottom-right');
  const greeting = String(w.greeting || 'Hi! How can we help?').replace(/'/g, "\\'");
  const widgetId = String(w.id);
  const collectEmail = w.collect_email ? 'true' : 'false';
  const collectName = w.collect_name ? 'true' : 'false';
  const branding = w.show_branding ? 'true' : 'false';
  const autoOpen = Number(w.auto_open_delay || 0);
  const isRight = position.includes('right');

  return `(function(){
  if(window.__echoChat)return;window.__echoChat=true;
  var API='https://echo-live-chat.bmcii1976.workers.dev';
  var WID='${widgetId}';
  var COLOR='${color}';
  var GREETING='${greeting}';
  var POS_RIGHT=${isRight};
  var COLLECT_EMAIL=${collectEmail};
  var COLLECT_NAME=${collectName};
  var BRANDING=${branding};
  var AUTO_OPEN=${autoOpen};
  var state={open:false,cid:null,vid:null,msgs:[],polling:null};

  function el(tag,attrs,parent){var e=document.createElement(tag);if(attrs)Object.keys(attrs).forEach(function(k){if(k==='text')e.textContent=attrs[k];else if(k==='html')e.innerHTML=attrs[k];else e.setAttribute(k,attrs[k]);});if(parent)parent.appendChild(e);return e;}

  // Styles
  var css=document.createElement('style');
  css.textContent=\`
    #echo-chat-btn{position:fixed;bottom:20px;\${POS_RIGHT?'right:20px':'left:20px'};width:60px;height:60px;border-radius:50%;background:\${COLOR};cursor:pointer;z-index:99999;display:flex;align-items:center;justify-content:center;box-shadow:0 4px 12px rgba(0,0,0,.3);transition:transform .2s}
    #echo-chat-btn:hover{transform:scale(1.1)}
    #echo-chat-btn svg{width:28px;height:28px;fill:#fff}
    #echo-chat-win{position:fixed;bottom:90px;\${POS_RIGHT?'right:20px':'left:20px'};width:380px;max-height:560px;border-radius:16px;overflow:hidden;z-index:99999;display:none;flex-direction:column;box-shadow:0 8px 32px rgba(0,0,0,.25);font-family:-apple-system,BlinkMacSystemFont,sans-serif}
    #echo-chat-win.open{display:flex}
    .ech{background:\${COLOR};color:#fff;padding:16px;display:flex;align-items:center;justify-content:space-between}
    .ech h3{margin:0;font-size:16px;font-weight:600}
    .ech button{background:none;border:none;color:#fff;cursor:pointer;font-size:20px}
    .ecb{flex:1;overflow-y:auto;padding:12px;background:#f9fafb;min-height:300px}
    .ecm{margin:6px 0;max-width:80%;padding:10px 14px;border-radius:12px;font-size:14px;line-height:1.4;word-wrap:break-word}
    .ecm.v{background:#e5e7eb;color:#111;border-bottom-left-radius:4px;margin-right:auto}
    .ecm.a{background:\${COLOR};color:#fff;border-bottom-right-radius:4px;margin-left:auto}
    .ecm.ai{background:\${COLOR}22;color:#333;border:1px solid \${COLOR}44;border-bottom-left-radius:4px;margin-right:auto}
    .ecf{padding:12px;background:#fff;border-top:1px solid #e5e7eb;display:flex;gap:8px}
    .ecf input{flex:1;border:1px solid #d1d5db;border-radius:8px;padding:8px 12px;font-size:14px;outline:none}
    .ecf input:focus{border-color:\${COLOR}}
    .ecf button{background:\${COLOR};color:#fff;border:none;border-radius:8px;padding:8px 16px;cursor:pointer;font-size:14px;font-weight:600}
    .ecp{padding:12px;background:#fff}
    .ecp input{width:100%;border:1px solid #d1d5db;border-radius:8px;padding:8px 12px;font-size:14px;margin-bottom:8px;outline:none;box-sizing:border-box}
    .ecp button{width:100%;background:\${COLOR};color:#fff;border:none;border-radius:8px;padding:10px;cursor:pointer;font-size:14px;font-weight:600}
    .ecbr{text-align:center;padding:4px;font-size:10px;color:#9ca3af;background:#fff}
    .ecbr a{color:#9ca3af;text-decoration:none}
  \`;
  document.head.appendChild(css);

  // Button
  var btn=el('div',{id:'echo-chat-btn'},document.body);
  btn.innerHTML='<svg viewBox="0 0 24 24"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H6l-2 2V4h16v12z"/></svg>';

  // Window
  var win=el('div',{id:'echo-chat-win'},document.body);
  var hdr=el('div',{class:'ech'},win);
  el('h3',{text:'Chat with us'},hdr);
  var closeBtn=el('button',{text:'\\u2715'},hdr);
  var body=el('div',{class:'ecb'},win);

  function addMsg(text,type){var m=el('div',{class:'ecm '+type},body);m.textContent=text;body.scrollTop=body.scrollHeight;}

  // Pre-chat form or direct chat
  var preChat=null;
  if(COLLECT_NAME||COLLECT_EMAIL){
    preChat=el('div',{class:'ecp'},win);
    var nameIn=COLLECT_NAME?el('input',{placeholder:'Your name',type:'text'},preChat):null;
    var emailIn=COLLECT_EMAIL?el('input',{placeholder:'Your email',type:'email'},preChat):null;
    var startBtn=el('button',{text:'Start Chat'},preChat);
    startBtn.onclick=function(){initChat(nameIn?nameIn.value:'',emailIn?emailIn.value:'');preChat.style.display='none';footer.style.display='flex';};
  }

  var footer=el('div',{class:'ecf'},win);
  var input=el('input',{placeholder:'Type a message...',type:'text'},footer);
  var sendBtn=el('button',{text:'Send'},footer);
  if(preChat)footer.style.display='none';

  if(BRANDING){var br=el('div',{class:'ecbr'},win);br.innerHTML='Powered by <a href="https://echo-ept.com/live-chat" target="_blank">Echo</a>';}

  addMsg(GREETING,'a');

  function initChat(name,email){
    fetch(API+'/v/init',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({widget_id:WID,name:name,email:email,page_url:location.href,referrer:document.referrer,user_agent:navigator.userAgent})})
    .then(function(r){return r.json()})
    .then(function(d){
      if(d.ok){state.cid=d.conversation_id;state.vid=d.visitor_id;startPolling();}
    }).catch(function(e){console.error('widget_init_chat failed:',e);});
  }

  function sendMessage(){
    var text=input.value.trim();if(!text||!state.cid)return;
    addMsg(text,'v');input.value='';
    fetch(API+'/v/message',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({conversation_id:state.cid,visitor_id:state.vid,content:text,visitor_name:'Visitor'})})
    .then(function(r){return r.json()})
    .then(function(d){if(d.ai_reply)addMsg(d.ai_reply,'ai');}).catch(function(e){console.error('widget_send_message failed:',e);});
  }

  function startPolling(){
    if(state.polling)return;
    var lastTs='';
    state.polling=setInterval(function(){
      if(!state.cid)return;
      var url=API+'/v/messages?conversation_id='+state.cid;
      if(lastTs)url+='&after='+encodeURIComponent(lastTs);
      fetch(url).then(function(r){return r.json()}).then(function(msgs){
        if(Array.isArray(msgs)){
          msgs.forEach(function(m){
            if(m.sender_type!=='visitor'){addMsg(m.content,m.ai_generated?'ai':'a');lastTs=m.created_at;}
          });
        }
      }).catch(function(e){console.error('widget_poll_messages failed:',e);});
    },3000);
  }

  sendBtn.onclick=sendMessage;
  input.onkeydown=function(e){if(e.key==='Enter')sendMessage();};

  btn.onclick=function(){
    state.open=!state.open;
    win.classList.toggle('open',state.open);
    if(state.open&&!preChat&&!state.cid)initChat('','');
  };
  closeBtn.onclick=function(){state.open=false;win.classList.remove('open');};

  if(AUTO_OPEN>0)setTimeout(function(){state.open=true;win.classList.add('open');if(!preChat&&!state.cid)initChat('','');},AUTO_OPEN*1000);
})();`;
}
