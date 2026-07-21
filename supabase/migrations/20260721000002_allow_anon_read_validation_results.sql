-- The app's server and browser Supabase clients use the anon key with no
-- authenticated session, but the existing storage policy only granted SELECT
-- to auth.role() = 'authenticated', so createSignedUrl always 404'd. Signed
-- URLs are already the access control (time-limited, path requires the job
-- UUID) — this just lets the anon-keyed client generate them, matching the
-- "Public read" pattern already used for the client-attachments bucket.
alter policy "Authenticated read validation results"
  on storage.objects
  to public
  using (bucket_id = 'validation-results');
