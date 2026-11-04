-- contact_event is append-only. A correction is a NEW event with corrects_event_id.
-- Any UPDATE or DELETE raises and the transaction aborts. See SPEC.md section 5.

CREATE FUNCTION contact_event_append_only() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'contact_event is append-only; % rejected', TG_OP
    USING ERRCODE = 'P0001',
    HINT = 'supersede by inserting a new event with corrects_event_id';
END;
$$;

CREATE TRIGGER contact_event_append_only
BEFORE UPDATE OR DELETE ON contact_event
FOR EACH STATEMENT EXECUTE FUNCTION contact_event_append_only();
