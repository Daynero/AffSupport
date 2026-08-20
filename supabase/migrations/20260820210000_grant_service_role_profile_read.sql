-- Server-side entitlement issuance reads account status and plan through the
-- service-role client. RLS bypass alone does not grant table privileges.
grant select on table public.profiles to service_role;
