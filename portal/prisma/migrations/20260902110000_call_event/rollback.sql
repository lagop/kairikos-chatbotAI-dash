-- Rollback for 20260902110000_call_event.
-- Recordings live at Twilio, not here, so dropping this table loses the
-- INDEX of what was recorded (and the 30-day purge's worklist) but no
-- audio. Recordings past retention would then need purging by hand.

DROP TABLE IF EXISTS "CallEvent";
