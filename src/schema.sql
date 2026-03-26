-- Echo Live Chat v1.0.0 — Intercom/Drift alternative
-- Embeddable AI-powered chat widgets for websites

CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  domain TEXT,
  plan TEXT DEFAULT 'starter',
  max_agents INTEGER DEFAULT 3,
  max_widgets INTEGER DEFAULT 1,
  max_conversations_per_day INTEGER DEFAULT 100,
  ai_enabled INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  avatar_url TEXT,
  role TEXT DEFAULT 'agent',
  status TEXT DEFAULT 'offline',
  max_concurrent INTEGER DEFAULT 5,
  auto_assign INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(tenant_id, email)
);

CREATE TABLE IF NOT EXISTS widgets (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  name TEXT DEFAULT 'Default Widget',
  position TEXT DEFAULT 'bottom-right',
  primary_color TEXT DEFAULT '#14b8a6',
  greeting TEXT DEFAULT 'Hi! How can we help you today?',
  offline_message TEXT DEFAULT 'We are currently offline. Leave a message and we will get back to you.',
  collect_email INTEGER DEFAULT 1,
  collect_name INTEGER DEFAULT 1,
  show_branding INTEGER DEFAULT 1,
  auto_open_delay INTEGER DEFAULT 0,
  allowed_domains TEXT,
  business_hours TEXT,
  ai_fallback INTEGER DEFAULT 1,
  ai_engine_id TEXT DEFAULT 'GEN-01',
  ai_system_prompt TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(tenant_id, name)
);

CREATE TABLE IF NOT EXISTS visitors (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  widget_id TEXT NOT NULL,
  name TEXT,
  email TEXT,
  ip_address TEXT,
  user_agent TEXT,
  country TEXT,
  city TEXT,
  page_url TEXT,
  referrer TEXT,
  sessions INTEGER DEFAULT 1,
  first_seen TEXT DEFAULT (datetime('now')),
  last_seen TEXT DEFAULT (datetime('now')),
  tags TEXT DEFAULT '[]',
  custom_data TEXT DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  widget_id TEXT NOT NULL,
  visitor_id TEXT NOT NULL,
  assigned_agent_id TEXT,
  status TEXT DEFAULT 'open',
  priority TEXT DEFAULT 'normal',
  subject TEXT,
  channel TEXT DEFAULT 'chat',
  rating INTEGER,
  feedback TEXT,
  tags TEXT DEFAULT '[]',
  started_at TEXT DEFAULT (datetime('now')),
  last_message_at TEXT DEFAULT (datetime('now')),
  closed_at TEXT,
  resolved_by TEXT
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  sender_type TEXT NOT NULL,
  sender_id TEXT,
  sender_name TEXT,
  content TEXT NOT NULL,
  content_type TEXT DEFAULT 'text',
  attachment_url TEXT,
  attachment_name TEXT,
  ai_generated INTEGER DEFAULT 0,
  read_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS canned_responses (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  shortcut TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  category TEXT DEFAULT 'general',
  use_count INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(tenant_id, shortcut)
);

CREATE TABLE IF NOT EXISTS triggers (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  name TEXT NOT NULL,
  event TEXT NOT NULL,
  conditions TEXT DEFAULT '{}',
  actions TEXT DEFAULT '[]',
  enabled INTEGER DEFAULT 1,
  fire_count INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tags (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  name TEXT NOT NULL,
  color TEXT DEFAULT '#6b7280',
  use_count INTEGER DEFAULT 0,
  UNIQUE(tenant_id, name)
);

CREATE TABLE IF NOT EXISTS analytics_daily (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
  date TEXT NOT NULL,
  conversations_started INTEGER DEFAULT 0,
  conversations_resolved INTEGER DEFAULT 0,
  messages_sent INTEGER DEFAULT 0,
  messages_received INTEGER DEFAULT 0,
  ai_responses INTEGER DEFAULT 0,
  avg_response_time_sec REAL DEFAULT 0,
  avg_satisfaction REAL DEFAULT 0,
  unique_visitors INTEGER DEFAULT 0,
  UNIQUE(tenant_id, date)
);

CREATE TABLE IF NOT EXISTS activity_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
  actor TEXT,
  action TEXT NOT NULL,
  target TEXT,
  details TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_agents_tenant ON agents(tenant_id);
CREATE INDEX IF NOT EXISTS idx_widgets_tenant ON widgets(tenant_id);
CREATE INDEX IF NOT EXISTS idx_visitors_tenant ON visitors(tenant_id);
CREATE INDEX IF NOT EXISTS idx_conversations_tenant_status ON conversations(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_conversations_agent ON conversations(assigned_agent_id);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_messages_tenant ON messages(tenant_id, created_at);
CREATE INDEX IF NOT EXISTS idx_canned_tenant ON canned_responses(tenant_id);
CREATE INDEX IF NOT EXISTS idx_triggers_tenant ON triggers(tenant_id);
CREATE INDEX IF NOT EXISTS idx_analytics_tenant_date ON analytics_daily(tenant_id, date);
CREATE INDEX IF NOT EXISTS idx_activity_tenant ON activity_log(tenant_id, created_at);
