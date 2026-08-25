-- Rollback for 20260902100000_virtual_number.
-- WARNING: dropping this table loses the mapping between clients and the
-- numbers they were forwarding to. Numbers still provisioned at the
-- provider are NOT released by this rollback — check the provider console
-- before running it, or you will keep paying for orphaned numbers.

DROP TABLE IF EXISTS "VirtualNumber";
