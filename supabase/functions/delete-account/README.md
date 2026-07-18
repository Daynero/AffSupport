# Delete account Edge Function

This function accepts only the current Supabase JWT and never accepts a user id from the browser. It deletes that authenticated Auth user with the server-only service-role key supplied automatically by Supabase. The profile cascades away and analytics rows are retained only after `user_id` is set to `null` by the foreign key.

Keep `VITE_DELETE_ACCOUNT_ENABLED=false` until this function has been deployed and `WISHLY_SITE_URL` has been configured as a Supabase Function secret. Deployment steps are in `docs/SUPABASE_SETUP.md`.
