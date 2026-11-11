import { createClient } from '@supabase/supabase-js'
import { SUPABASE_URL, SUPABASE_KEY } from '../config'

export const sb = createClient(SUPABASE_URL, SUPABASE_KEY)
