import { createClient } from '@supabase/supabase-js';

export const SUPABASE_URL = 'https://kikpopuatxzciryqkbfj.supabase.co';
export const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imtpa3BvcHVhdHh6Y2lyeXFrYmZqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzE0Mjg0NDEsImV4cCI6MjA4NzAwNDQ0MX0.JsqlmF6M7Y9aNarp7LA8nEYZ0NsAJEYwcnMACIEcBAI';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
