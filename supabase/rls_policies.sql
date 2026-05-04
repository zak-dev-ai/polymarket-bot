-- Enable public read access for dashboard (anon key)
-- Bot writes with service_role key, dashboard reads with anon key

-- Disable RLS — since this is a personal bot, not multi-user
-- This is the simplest approach. For production, create proper RLS policies.
alter table bot_state disable row level security;
alter table trades disable row level security;
alter table signals disable row level security;
alter table alerts disable row level security;
alter table agent_status disable row level security;
alter table markets disable row level security;
